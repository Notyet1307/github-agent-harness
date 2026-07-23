import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.js";
import { reconcileJob } from "../src/reconcile.js";
import { recover } from "../src/recover.js";

/**
 * Simulate the M5 stage matrix as ledger states + hints
 * (no Orca side effects).
 */
const stages: Array<{
  name: string;
  state: Parameters<typeof reconcileJob>[0] extends infer J
    ? J extends { state: infer S }
      ? S
      : never
    : never;
  hints?: Parameters<typeof reconcileJob>[1];
  expect: string;
}> = [
  { name: "after claim", state: "claimed", expect: "run_once" },
  { name: "worktree ready", state: "worktree_ready", expect: "run_once" },
  {
    name: "codex mid-flight",
    state: "implementing",
    hints: { hasCommitsSinceBase: false },
    expect: "run_once",
  },
  {
    name: "codex done ledger stale",
    state: "implementing",
    hints: { hasCommitsSinceBase: true, trackedClean: true },
    expect: "run_once",
  },
  { name: "ready for pi", state: "awaiting_audit", expect: "audit_once" },
  {
    name: "pi mid / result on disk",
    state: "auditing",
    hints: { auditResultReady: true },
    expect: "audit_once",
  },
  { name: "audit passed", state: "audit_passed", expect: "publish_once" },
  {
    name: "push done PR exists",
    state: "publishing",
    hints: { prExists: true },
    expect: "publish_once",
  },
  {
    name: "pr open",
    state: "awaiting_merge",
    hints: { prExists: true },
    expect: "wait_merge",
  },
  {
    name: "pr merged ledger stale",
    state: "awaiting_merge",
    hints: { prMerged: true },
    expect: "wait_merge",
  },
];

test("M5 stage matrix maps to ensure* actions", () => {
  for (const s of stages) {
    const job = {
      id: "x",
      repo: "o/r",
      issue_number: 1,
      issue_url: "u",
      issue_updated_at: "t",
      issue_snapshot_json: "{}",
      state: s.state as never,
      base_ref: "origin/main",
      base_sha: "b",
      branch: "br",
      worktree_id: "w",
      worktree_path: "/tmp",
      implementer_profile_id: null,
      implementer_terminal_handle: null,
      implementer_task_id: null,
      implementer_dispatch_id: null,
      auditor_profile_id: null,
      auditor_terminal_handle: null,
      auditor_task_id: null,
      auditor_dispatch_id: null,
      dispatch_attempt: 0,
      dispatch_probe_pending: 0,
      controller_terminal_handle: null,
      audit_round: 0,
      audit_result_json: null,
      audit_head_sha: null,
      pr_number: null,
      pr_url: null,
      merged_at: null,
      last_error: null,
      head_sha: null,
      created_at: "t",
      updated_at: "t",
    };
    const action = reconcileJob(job, s.hints ?? {});
    assert.equal(
      action.kind,
      s.expect,
      `${s.name}: expected ${s.expect}, got ${action.kind}`,
    );
  }
});

test("ledger fixture: active implementing blocks new claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-m5-"));
  const dbPath = join(dir, "h.sqlite");
  const ledger = new Ledger(dbPath);
  try {
    const claim = ledger.tryClaim({
      id: "job1",
      repo: "o/r",
      issue: {
        number: 7,
        title: "t",
        url: "u",
        updatedAt: "t",
        blockedBy: [],
        labels: ["ready-for-agent"],
      },
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    });
    assert.equal(claim.ok, true);
    ledger.updateJob("job1", {
      state: "implementing",
      base_sha: "aaa",
      worktree_path: join(dir, "wt"),
    });
    mkdirSync(join(dir, "wt"), { recursive: true });
    writeFileSync(join(dir, "wt", "x"), "1");

    const second = ledger.tryClaim({
      id: "job2",
      repo: "o/r",
      issue: {
        number: 8,
        title: "t2",
        url: "u2",
        updatedAt: "t",
        blockedBy: [],
        labels: ["ready-for-agent"],
      },
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    });
    assert.equal(second.ok, false);
    assert.equal(ledger.hasActiveJob(), true);
    assert.equal(ledger.getActiveJob()?.issue_number, 7);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recover executes a completed blocked audit result through the gate", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-recover-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worktree = join(dir, "worktree");
  mkdirSync(worktree);
  git(worktree, "init", "-b", "main");
  git(worktree, "config", "user.name", "Harness Test");
  git(worktree, "config", "user.email", "harness@example.test");
  writeFileSync(join(worktree, "value.txt"), "base\n");
  git(worktree, "add", "value.txt");
  git(worktree, "commit", "-m", "base");
  const baseSha = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "value.txt"), "head\n");
  git(worktree, "add", "value.txt");
  git(worktree, "commit", "-m", "head");
  const headSha = git(worktree, "rev-parse", "HEAD");

  const resultDir = join(worktree, ".harness");
  mkdirSync(resultDir);
  writeFileSync(
    join(resultDir, "audit-result.json"),
    JSON.stringify({
      status: "pass",
      base_sha: baseSha,
      head_sha: headSha,
      standards: {
        documented_standard_violations: [],
        smell_judgement_calls: [],
      },
      spec: {
        missing_or_partial: [],
        incorrect_implementation: [],
        scope_creep: [],
      },
      validation: {
        commands: [{ command: "npm test", exit_code: 0, ok: true }],
      },
    }),
  );

  const fakeOrca = join(dir, "orca.cjs");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
const key = args.slice(0, 2).join(" ");
if (args[0] === "status") {
  console.log(JSON.stringify({ ok: true, result: {
    app: { running: true },
    runtime: { state: "ready", reachable: true }
  } }));
} else if (key === "orchestration task-list") {
  console.log(JSON.stringify({ ok: true, result: {
    tasks: [{ id: "task-audit", status: "completed" }]
  } }));
} else if (key === "terminal list") {
  console.log(JSON.stringify({ ok: true, result: {
    terminals: [{
      handle: "controller-1",
      title: "test-controller",
      connected: true
    }]
  } }));
} else if (key === "worktree set") {
  console.log(JSON.stringify({ ok: true, result: {} }));
} else {
  console.log(JSON.stringify({ ok: false, error: {
    message: "unexpected " + key
  } }));
  process.exitCode = 1;
}
`,
  );
  chmodSync(fakeOrca, 0o755);

  const configPath = join(dir, "harness.yaml");
  writeFileSync(
    configPath,
    `version: 1
issueLabel: ready-for-agent
maxAuditRounds: 3
orca:
  cliPath: ${JSON.stringify(fakeOrca)}
  cliPathFallback: ${JSON.stringify(fakeOrca)}
  controllerWorktreePath: ${JSON.stringify(dir)}
  controllerTitle: test-controller
activeProfiles:
  implementer: codex-default
  auditor: pi-reviewer
agentProfiles:
  codex-default:
    id: codex-default
    role: implementer
    runtime: orca
    orcaAgent: codex
    invokeHint: implement
  pi-reviewer:
    id: pi-reviewer
    role: auditor
    runtime: orca
    orcaAgent: pi
    readonly: true
    invokeHint: audit
repositories:
  - github: owner/repo
    localPath: ${JSON.stringify(worktree)}
    orcaRepoId: repo-1
    baseRef: origin/main
    defaultBranch: main
`,
  );

  const ledgerPath = join(dir, "harness.sqlite");
  const ledger = new Ledger(ledgerPath);
  const claimed = ledger.tryClaim({
    id: "job-audit",
    repo: "owner/repo",
    issue: {
      number: 8,
      title: "Audit recovery",
      url: "https://example.test/issues/8",
      updatedAt: "2026-07-23T00:00:00Z",
      blockedBy: [],
      labels: ["ready-for-agent"],
    },
    baseRef: "origin/main",
    implementerProfileId: "codex-default",
  });
  assert.equal(claimed.ok, true);
  ledger.updateJob("job-audit", {
    state: "blocked",
    base_sha: baseSha,
    worktree_id: "worktree-1",
    worktree_path: worktree,
    auditor_profile_id: "pi-reviewer",
    auditor_terminal_handle: "pi-1",
    auditor_task_id: "task-audit",
    auditor_dispatch_id: "dispatch-audit",
    controller_terminal_handle: "controller-1",
    audit_round: 1,
    audit_head_sha: headSha,
    head_sha: headSha,
    last_error:
      "worker raised decision_gate (unsupported in M2 auto path)",
  });
  ledger.close();

  const result = recover({
    configPath,
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
    dryRun: false,
  });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.action.kind, "audit_once");
  const verified = new Ledger(ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "audit_passed");
  verified.close();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}
