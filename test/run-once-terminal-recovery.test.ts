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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.js";
import { runOnce } from "../src/run-once.js";

type FixtureMode = "new" | "pending" | "accepted" | "missing";

function createFixture(mode: FixtureMode): {
  dir: string;
  ledgerPath: string;
  configPath: string;
  callsPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "run-once-terminal-"));

  const worktree = join(dir, "worktree");
  mkdirSync(worktree);
  git(worktree, "init", "-b", "agent/issue-12");
  git(worktree, "config", "user.name", "Harness Test");
  git(worktree, "config", "user.email", "harness@example.test");
  writeFileSync(join(worktree, "value.txt"), "base\n");
  git(worktree, "add", "value.txt");
  git(worktree, "commit", "-m", "base");
  const baseSha = git(worktree, "rev-parse", "HEAD");
  if (mode === "pending" || mode === "accepted") {
    writeFileSync(join(worktree, "value.txt"), "existing fix\n");
    git(worktree, "add", "value.txt");
    git(worktree, "commit", "-m", "existing fix");
  }

  const callsPath = join(dir, "orca-calls.jsonl");
  const statePath = join(dir, "orca-state");
  const fakeOrca = join(dir, "orca.cjs");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
const key = args.slice(0, 2).join(" ");
const mode = ${JSON.stringify(mode)};
const dispatched = existsSync(${JSON.stringify(statePath)});
const ok = (result) => console.log(JSON.stringify({ ok: true, result }));
if (args[0] === "status") {
  ok({ app: { running: true }, runtime: { state: "ready", reachable: true } });
} else if (key === "terminal list" && args.includes(${JSON.stringify(`path:${dir}`)})) {
  ok({ terminals: [{ handle: "controller-1", title: "test-controller", connected: true }] });
} else if (key === "terminal list") {
  ok({ terminals: [] });
} else if (key === "terminal create") {
  if (mode === "missing") {
    console.log(JSON.stringify({ ok: false, error: { message: "terminal create failed" } }));
    process.exitCode = 1;
  } else {
    ok({ handle: "implementer-new" });
  }
} else if (key === "terminal wait") {
  const handle = args[args.indexOf("--terminal") + 1];
  if (handle === "implementer-stale") {
    console.log(JSON.stringify({ ok: false, error: { message: "terminal implementer-stale not found" } }));
    process.exitCode = 1;
  } else {
    ok({ wait: { satisfied: true, blockedReason: null } });
  }
} else if (key === "terminal read") {
  ok({ terminal: {
    nextCursor: dispatched ? "2" : "1",
    tail:
      mode === "pending"
        ? ["Your task id is task-existing"]
        : dispatched ? ["Your task id is task-new"] : []
  } });
} else if (key === "terminal show") {
  ok({ terminal: { handle: "implementer-new", title: "issue-12-codex" } });
} else if (key === "orchestration task-create") {
  if (mode !== "new") {
    console.log(JSON.stringify({ ok: false, error: { message: "unexpected task creation" } }));
    process.exitCode = 1;
  } else {
    ok({ taskId: "task-new" });
  }
} else if (key === "orchestration dispatch") {
  const to = args[args.indexOf("--to") + 1];
  if (mode !== "new" || to !== "implementer-new") {
    console.log(JSON.stringify({ ok: false, error: { message: "dispatch used stale terminal " + to } }));
    process.exitCode = 1;
  } else {
    writeFileSync(${JSON.stringify(join(worktree, "value.txt"))}, "fixed\\n");
    execFileSync("git", ["-C", ${JSON.stringify(worktree)}, "add", "value.txt"]);
    execFileSync("git", ["-C", ${JSON.stringify(worktree)}, "commit", "-m", "fix"]);
    writeFileSync(${JSON.stringify(statePath)}, "dispatched");
    ok({ dispatchId: "dispatch-new" });
  }
} else if (key === "orchestration check") {
  ok({ messages: [{
    type: "worker_done",
    taskId: "task-new",
    dispatchId: "dispatch-new"
  }] });
} else if (key === "worktree set") {
  ok({});
} else {
  console.log(JSON.stringify({ ok: false, error: { message: "unexpected " + args.join(" ") } }));
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
implementTimeoutMinutes: 1
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
  const claim = ledger.tryClaim({
    id: "job-terminal",
    repo: "owner/repo",
    issue: {
      number: 12,
      title: "Recover stale terminal",
      url: "https://example.test/issues/12",
      updatedAt: "2026-07-23T00:00:00Z",
      labels: ["ready-for-agent"],
      blockedBy: [],
    },
    baseRef: "origin/main",
    implementerProfileId: "codex-default",
  });
  assert.equal(claim.ok, true);
  const hasTask = mode === "pending" || mode === "accepted";
  ledger.updateJob("job-terminal", {
    state: hasTask ? "implementing" : "worktree_ready",
    base_sha: baseSha,
    branch: "agent/issue-12",
    worktree_id: "worktree-1",
    worktree_path: worktree,
    implementer_terminal_handle: "implementer-stale",
    implementer_task_id: hasTask ? "task-existing" : null,
    implementer_dispatch_id: hasTask ? "dispatch-existing" : null,
    dispatch_attempt: hasTask ? 1 : 0,
    dispatch_probe_pending: mode === "pending" ? 1 : 0,
  });
  ledger.close();

  return { dir, ledgerPath, configPath, callsPath };
}

test("runOnce rebinds a stale implementer terminal before dispatch", (t) => {
  const fixture = createFixture("new");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, true, result.message);
  const verified = new Ledger(fixture.ledgerPath);
  const job = verified.getJob("job-terminal");
  assert.equal(job?.state, "awaiting_audit");
  assert.equal(job?.implementer_terminal_handle, "implementer-new");
  assert.equal(job?.implementer_task_id, "task-new");
  verified.close();

  const calls = readCalls(fixture.callsPath);
  assert.equal(
    calls.some(
      (args) =>
        args[0] === "orchestration" &&
        args[1] === "dispatch" &&
        args[args.indexOf("--to") + 1] === "implementer-stale",
    ),
    false,
  );
  assert.equal(
    calls.some(
      (args) =>
        args[0] === "orchestration" &&
        args[1] === "dispatch" &&
        args[args.indexOf("--to") + 1] === "implementer-new",
    ),
    true,
  );
});

test("runOnce blocks instead of falling back to a stale terminal", (t) => {
  const fixture = createFixture("missing");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /no implementer terminal handle/);
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) =>
        args[0] === "orchestration" && args[1] === "dispatch",
    ),
    false,
  );
});

test("runOnce rebinds an acceptance-pending task without redispatch", (t) => {
  const fixture = createFixture("pending");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, true, result.message);
  const verified = new Ledger(fixture.ledgerPath);
  const job = verified.getJob("job-terminal");
  assert.equal(job?.state, "awaiting_audit");
  assert.equal(job?.implementer_terminal_handle, "implementer-new");
  assert.equal(job?.implementer_task_id, "task-existing");
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) =>
        args[0] === "orchestration" &&
        (args[1] === "task-create" || args[1] === "dispatch"),
    ),
    false,
  );
});

test("runOnce does not rebind or redispatch an accepted task", (t) => {
  const fixture = createFixture("accepted");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, true, result.message);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(
    verified.getJob("job-terminal")?.implementer_terminal_handle,
    "implementer-stale",
  );
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) =>
        (args[0] === "terminal" &&
          args[1] === "list" &&
          args.includes("id:worktree-1")) ||
        (args[0] === "orchestration" && args[1] === "dispatch"),
    ),
    false,
  );
});

function readCalls(path: string): string[][] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
