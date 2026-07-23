import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.js";
import {
  IMPLEMENT_NO_COMMITS_ERROR,
  reconcileJob,
} from "../src/reconcile.js";
import { recover } from "../src/recover.js";
import { runOnce } from "../src/run-once.js";

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

test("explicit retry redispatches in the recorded worktree and preserves partial changes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-retry-implement-"));
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
  writeFileSync(join(worktree, "value.txt"), "unfinished\n");

  const fakeOrca = join(dir, "orca.cjs");
  const callsPath = join(dir, "calls.jsonl");
  const modePath = join(dir, "mode");
  writeFileSync(callsPath, "");
  writeFileSync(modePath, "fail");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { dirname, join } = require("node:path");
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
appendFileSync(join(dirname(process.argv[1]), "calls.jsonl"), JSON.stringify(args) + "\\n");
const mode = readFileSync(join(dirname(process.argv[1]), "mode"), "utf8");
const key = args.slice(0, 2).join(" ");
if (args[0] === "status") {
  console.log(JSON.stringify({ ok: true, result: {
    app: { running: true },
    runtime: { state: "ready", reachable: true }
  } }));
} else if (key === "orchestration task-list") {
  if (mode === "dirty-after-hints") {
    writeFileSync(${JSON.stringify(join(worktree, "value.txt"))}, "dirty after hints\\n");
  }
  if (mode === "live-after-hints") {
    writeFileSync(join(dirname(process.argv[1]), "mode"), "live");
  }
  console.log(JSON.stringify({ ok: true, result: {
    tasks: [{ id: "task-old", status: mode === "live" ? "working" : "completed" }]
  } }));
} else if (key === "terminal list") {
  const target = args[args.indexOf("--worktree") + 1];
  console.log(JSON.stringify({ ok: true, result: { terminals:
    target === "id:worktree-1"
      ? []
      : [{ handle: "controller-1", title: "test-controller", connected: true }]
  } }));
} else if (key === "terminal create") {
  console.log(JSON.stringify({ ok: true, result: { handle: "codex-new" } }));
} else if (key === "terminal wait") {
  console.log(JSON.stringify({ ok: true, result: {
    wait: { satisfied: true, status: "idle", blockedReason: null }
  } }));
} else if (key === "terminal read") {
  console.log(JSON.stringify({ ok: true, result: { terminal: {
    tail: ["Working on task-new"],
    nextCursor: "2",
    latestCursor: "2"
  } } }));
} else if (key === "terminal show") {
  console.log(JSON.stringify({ ok: true, result: {
    terminal: { title: "codex", preview: "" }
  } }));
} else if (key === "orchestration task-create") {
  console.log(JSON.stringify({ ok: true, result: { taskId: "task-new" } }));
} else if (key === "orchestration dispatch") {
  if (mode === "fail") {
    console.log(JSON.stringify({ ok: true, result: {} }));
  } else {
    execFileSync("git", ["-C", ${JSON.stringify(worktree)}, "add", "value.txt"]);
    execFileSync("git", ["-C", ${JSON.stringify(worktree)}, "commit", "-m", "finish partial work"]);
    console.log(JSON.stringify({ ok: true, result: { dispatchId: "dispatch-new" } }));
  }
} else if (key === "orchestration task-update") {
  if (mode === "fail") {
    console.log(JSON.stringify({ ok: false, error: {
      message: "task update unavailable"
    } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, result: {} }));
  }
} else if (key === "orchestration check") {
  console.log(JSON.stringify({ ok: true, result: { messages: [{
    type: "worker_done",
    payload: JSON.stringify({ taskId: "task-new", dispatchId: "dispatch-new" })
  }] } }));
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
    id: "job-retry",
    repo: "owner/repo",
    issue: {
      number: 10,
      title: "Retry implementation",
      url: "https://example.test/issues/10",
      updatedAt: "2026-07-23T00:00:00Z",
      blockedBy: [],
      labels: ["ready-for-agent"],
    },
    baseRef: "origin/main",
    implementerProfileId: "codex-default",
  });
  assert.equal(claimed.ok, true);
  ledger.updateJob("job-retry", {
    state: "blocked",
    base_sha: baseSha,
    branch: "main",
    worktree_id: "worktree-1",
    worktree_path: worktree,
    implementer_terminal_handle: "codex-old",
    implementer_task_id: "task-old",
    implementer_dispatch_id: "dispatch-old",
    dispatch_attempt: 1,
    last_error: IMPLEMENT_NO_COMMITS_ERROR,
  });
  ledger.close();

  const failed = recover({
    configPath,
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
    dryRun: false,
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.action.kind, "retry_implement");
  const failedLedger = new Ledger(ledgerPath);
  assert.equal(failedLedger.getJob("job-retry")?.state, "blocked");
  assert.equal(
    failedLedger.getJob("job-retry")?.implementer_task_id,
    "task-new",
  );
  assert.equal(
    failedLedger.getJob("job-retry")?.implementer_dispatch_id,
    null,
  );
  assert.equal(failedLedger.getJob("job-retry")?.dispatch_attempt, 1);
  failedLedger.close();
  const blocked = recover({
    configPath,
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
    dryRun: true,
  });
  assert.equal(blocked.action.kind, "blocked");

  const retryLedger = new Ledger(ledgerPath);
  retryLedger.updateJob("job-retry", {
    state: "blocked",
    implementer_terminal_handle: "codex-old",
    implementer_task_id: "task-old",
    implementer_dispatch_id: "dispatch-old",
    dispatch_attempt: 1,
    last_error: IMPLEMENT_NO_COMMITS_ERROR,
  });
  retryLedger.close();
  writeFileSync(modePath, "success");

  const result = recover({
    configPath,
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
    dryRun: false,
  });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.action.kind, "retry_implement");
  assert.equal(result.executed, true);
  assert.match(result.message, /recover→run-once/);
  const after = new Ledger(ledgerPath);
  assert.equal(after.getJob("job-retry")?.state, "awaiting_audit");
  assert.equal(after.getJob("job-retry")?.implementer_task_id, "task-new");
  assert.equal(after.getJob("job-retry")?.implementer_dispatch_id, "dispatch-new");
  assert.equal(readFileSync(join(worktree, "value.txt"), "utf8"), "unfinished\n");
  const calls = readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(
    calls.some((args) => args[0] === "worktree" && args[1] === "create"),
    false,
  );
  after.close();

  const dirtyLedger = new Ledger(ledgerPath);
  dirtyLedger.updateJob("job-retry", {
    state: "blocked",
    head_sha: baseSha,
    implementer_terminal_handle: "codex-old",
    implementer_task_id: "task-old",
    implementer_dispatch_id: "dispatch-old",
    dispatch_attempt: 1,
    last_error: IMPLEMENT_NO_COMMITS_ERROR,
  });
  dirtyLedger.close();
  const taskCreatesBefore = calls.filter(
    (args) => args[0] === "orchestration" && args[1] === "task-create",
  ).length;

  const replacedJob = runOnce({
    configPath,
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
    blockedImplementationRecovery: {
      action: "finalize",
      jobId: "job-replaced",
      taskId: "task-old",
      dispatchId: "dispatch-old",
    },
  });
  assert.equal(replacedJob.ok, false);
  assert.match(replacedJob.message, /changed before recovery/);

  writeFileSync(modePath, "live-after-hints");
  const liveTask = recover({
    configPath,
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
    dryRun: false,
  });
  assert.equal(liveTask.action.kind, "finalize_implement");
  assert.equal(liveTask.ok, false);
  assert.match(liveTask.message, /task is not confirmed ended/);
  const liveVerified = new Ledger(ledgerPath);
  assert.equal(liveVerified.getJob("job-retry")?.state, "blocked");
  assert.equal(
    liveVerified.getJob("job-retry")?.last_error,
    IMPLEMENT_NO_COMMITS_ERROR,
  );
  liveVerified.close();

  writeFileSync(modePath, "dirty-after-hints");

  const dirtyFinalize = recover({
    configPath,
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
    dryRun: false,
  });

  assert.equal(dirtyFinalize.action.kind, "finalize_implement");
  assert.equal(dirtyFinalize.ok, false);
  const dirtyVerified = new Ledger(ledgerPath);
  assert.equal(dirtyVerified.getJob("job-retry")?.state, "blocked");
  dirtyVerified.close();

  git(worktree, "checkout", "--", "value.txt");
  const finalizableLedger = new Ledger(ledgerPath);
  finalizableLedger.updateJob("job-retry", {
    state: "blocked",
    head_sha: baseSha,
    implementer_terminal_handle: "codex-old",
    implementer_task_id: "task-old",
    implementer_dispatch_id: "dispatch-old",
    dispatch_attempt: 1,
    last_error: IMPLEMENT_NO_COMMITS_ERROR,
  });
  finalizableLedger.close();
  writeFileSync(modePath, "success");

  const finalized = recover({
    configPath,
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
    dryRun: false,
  });

  assert.equal(finalized.action.kind, "finalize_implement");
  assert.equal(finalized.ok, true, finalized.message);
  const finalLedger = new Ledger(ledgerPath);
  assert.equal(finalLedger.getJob("job-retry")?.state, "awaiting_audit");
  finalLedger.close();
  const finalCalls = readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(
    finalCalls.filter(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ).length,
    taskCreatesBefore,
  );
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
