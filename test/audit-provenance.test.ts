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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditOnce } from "../src/audit-once.js";
import { Ledger } from "../src/ledger.js";

test("a fresh audit round blocks and keeps an incomplete dispatch tuple", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "audit-provenance-"));
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

  mkdirSync(join(worktree, ".harness"));
  writeFileSync(
    join(worktree, ".harness", "audit-result.json"),
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
} else if (key === "terminal list") {
  console.log(JSON.stringify({ ok: true, result: {
    terminals: [{ handle: "controller-1", title: "test-controller", connected: true }]
  } }));
} else if (key === "terminal create") {
  console.log(JSON.stringify({ ok: true, result: { handle: "pi-new" } }));
} else if (key === "terminal wait") {
  console.log(JSON.stringify({ ok: true, result: {
    wait: { satisfied: true, status: "idle", blockedReason: null }
  } }));
} else if (key === "terminal read") {
  console.log(JSON.stringify({ ok: true, result: { terminal: {
    tail: [],
    nextCursor: "1",
    latestCursor: "1"
  } } }));
} else if (key === "orchestration task-create") {
  console.log(JSON.stringify({ ok: true, result: {
    taskId: "task-audit-new"
  } }));
} else if (key === "orchestration dispatch") {
  console.log(JSON.stringify({ ok: true, result: {} }));
} else if (key === "orchestration task-update") {
  console.log(JSON.stringify({ ok: false, error: {
    message: "task update unavailable"
  } }));
  process.exitCode = 1;
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
  assert.equal(
    ledger.tryClaim({
      id: "job-audit",
      repo: "owner/repo",
      issue: {
        number: 9,
        title: "Fresh audit",
        url: "https://example.test/issues/9",
        updatedAt: "2026-07-23T00:00:00Z",
        blockedBy: [],
        labels: ["ready-for-agent"],
      },
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    }).ok,
    true,
  );
  ledger.updateJob("job-audit", {
    state: "awaiting_audit",
    base_sha: baseSha,
    worktree_id: "worktree-1",
    worktree_path: worktree,
    head_sha: headSha,
  });
  ledger.close();

  const result = auditOnce({
    configPath,
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
    withRework: false,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /missing dispatchId/);
  const verified = new Ledger(ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.equal(
    verified.getJob("job-audit")?.auditor_task_id,
    "task-audit-new",
  );
  assert.equal(verified.getJob("job-audit")?.auditor_dispatch_id, null);
  assert.equal(verified.getJob("job-audit")?.dispatch_attempt, 1);
  verified.close();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}
