import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Ledger } from "../src/ledger.js";
import { acquireLock } from "../src/lock.js";
import { runOnce } from "../src/run-once.js";

type FixtureMode =
  | "new"
  | "ambiguous"
  | "pending"
  | "pending-failed"
  | "pending-failed-race"
  | "accepted"
  | "working"
  | "lock-wait"
  | "dispatch-lock-wait"
  | "idle-lock-wait"
  | "failed"
  | "late-failed"
  | "diverged"
  | "dirty"
  | "missing";

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
  git(
    worktree,
    "remote",
    "add",
    "origin",
    "https://github.com/owner/repo.git",
  );
  writeFileSync(join(worktree, "value.txt"), "base\n");
  git(worktree, "add", "value.txt");
  git(worktree, "commit", "-m", "base");
  const baseSha = git(worktree, "rev-parse", "HEAD");
  if (
    mode === "pending" ||
    mode === "accepted" ||
    mode === "working" ||
    mode === "lock-wait" ||
    mode === "failed" ||
    mode === "diverged" ||
    mode === "dirty"
  ) {
    writeFileSync(join(worktree, "value.txt"), "existing fix\n");
    git(worktree, "add", "value.txt");
    git(worktree, "commit", "-m", "existing fix");
    if (mode === "diverged") {
      const tree = git(worktree, "rev-parse", "HEAD^{tree}");
      const divergentHead = git(
        worktree,
        "commit-tree",
        tree,
        "-m",
        "divergent fix",
      );
      git(worktree, "reset", "--hard", divergentHead);
    }
    if (mode === "dirty") {
      writeFileSync(join(worktree, "value.txt"), "dirty fix\n");
    }
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
} else if (key === "repo list") {
  ok({ repos: [{
    id: "repo-1",
    path: ${JSON.stringify(worktree)},
    worktreeBaseRef: "origin/main",
    gitRemoteIdentity: { canonicalKey: "owner/repo" }
  }] });
} else if (key === "repo show") {
  ok({ repo: {
    id: "repo-1",
    path: ${JSON.stringify(worktree)},
    worktreeBaseRef: "origin/main",
    gitRemoteIdentity: { canonicalKey: "owner/repo" }
  } });
} else if (key === "terminal list" && args.includes(${JSON.stringify(`path:${process.cwd()}`)})) {
  ok({ terminals: [{ handle: "controller-1", title: "test-controller", connected: true }] });
} else if (key === "terminal list") {
  ok({ terminals: mode === "ambiguous" ? [
    { handle: "implementer-old-1", title: "issue-12-codex", connected: true },
    { handle: "implementer-old-2", title: "issue-12-codex", connected: true }
  ] : [] });
} else if (key === "terminal create") {
  if (mode === "missing") {
    console.log(JSON.stringify({ ok: false, error: { message: "terminal create failed" } }));
    process.exitCode = 1;
  } else {
    ok({ handle: "implementer-new" });
  }
} else if (key === "terminal wait") {
  const handle = args[args.indexOf("--terminal") + 1];
  if (mode === "idle-lock-wait") {
    writeFileSync(${JSON.stringify(join(dir, "idle-waiting"))}, "waiting");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(${JSON.stringify(join(dir, "release-idle"))})) {
      Atomics.wait(wait, 0, 0, 10);
    }
    ok({ wait: { satisfied: true, blockedReason: null } });
  } else if (handle === "implementer-stale") {
    console.log(JSON.stringify({ ok: false, error: { message: "terminal implementer-stale not found" } }));
    process.exitCode = 1;
  } else {
    ok({ wait: { satisfied: true, blockedReason: null } });
  }
} else if (key === "terminal read") {
  if (mode === "dispatch-lock-wait" && dispatched) {
    writeFileSync(${JSON.stringify(join(dir, "dispatch-waiting"))}, "waiting");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(${JSON.stringify(join(dir, "release-dispatch"))})) {
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  ok({ terminal: {
    nextCursor: dispatched ? "2" : "1",
    tail:
      mode === "pending"
        || mode === "pending-failed"
        ? ["Your task id is task-existing"]
        : dispatched ? ["Your task id is task-new"] : []
  } });
} else if (key === "terminal show") {
  ok({ terminal: { handle: "implementer-new", title: "issue-12-codex" } });
} else if (key === "orchestration task-list") {
  ok({ tasks: [{
    id: mode === "new" || mode === "ambiguous" || mode === "dispatch-lock-wait" || mode === "idle-lock-wait" ? "task-new" : "task-existing",
    status:
      mode === "failed" ||
      mode === "pending-failed" ||
      mode === "pending-failed-race" ||
      mode === "late-failed"
      ? "failed"
      : mode === "working" || mode === "lock-wait" || mode === "new" || mode === "ambiguous"
        ? "working"
        : "completed"
  }] });
} else if (key === "orchestration task-create") {
  if (
    mode !== "new" &&
    mode !== "ambiguous" &&
    mode !== "dispatch-lock-wait" &&
    mode !== "idle-lock-wait" &&
    mode !== "pending-failed-race"
  ) {
    console.log(JSON.stringify({ ok: false, error: { message: "unexpected task creation" } }));
    process.exitCode = 1;
  } else {
    ok({ taskId: "task-new" });
  }
} else if (key === "orchestration dispatch") {
  const to = args[args.indexOf("--to") + 1];
  if (
    (
      mode !== "new" &&
      mode !== "ambiguous" &&
      mode !== "dispatch-lock-wait" &&
      mode !== "pending-failed-race"
    ) ||
    to !== "implementer-new"
  ) {
    console.log(JSON.stringify({ ok: false, error: { message: "dispatch used stale terminal " + to } }));
    process.exitCode = 1;
  } else {
    writeFileSync(${JSON.stringify(join(worktree, "value.txt"))}, "fixed\\n");
    execFileSync("git", ["-C", ${JSON.stringify(worktree)}, "add", "value.txt"]);
    execFileSync("git", ["-C", ${JSON.stringify(worktree)}, "commit", "-m", "fix"]);
    writeFileSync(${JSON.stringify(statePath)}, "dispatched");
    ok({ dispatchId: "dispatch-new" });
  }
} else if (key === "orchestration task-update") {
  if (mode === "pending-failed-race") {
    writeFileSync(${JSON.stringify(join(worktree, "value.txt"))}, "late failed fix\\n");
    execFileSync("git", ["-C", ${JSON.stringify(worktree)}, "add", "value.txt"]);
    execFileSync("git", ["-C", ${JSON.stringify(worktree)}, "commit", "-m", "late failed fix"]);
    ok({});
  } else {
    console.log(JSON.stringify({ ok: false, error: { message: "unexpected task update" } }));
    process.exitCode = 1;
  }
} else if (key === "orchestration check") {
  if (mode === "lock-wait") {
    writeFileSync(${JSON.stringify(join(dir, "worker-waiting"))}, "waiting");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(${JSON.stringify(join(dir, "release-worker"))})) {
      Atomics.wait(wait, 0, 0, 10);
    }
    ok({ messages: [{
      type: "worker_done",
      taskId: "task-existing",
      dispatchId: "dispatch-existing"
    }] });
  } else if (mode === "late-failed") {
    writeFileSync(${JSON.stringify(join(worktree, "value.txt"))}, "late failed fix\\n");
    execFileSync("git", ["-C", ${JSON.stringify(worktree)}, "add", "value.txt"]);
    execFileSync("git", ["-C", ${JSON.stringify(worktree)}, "commit", "-m", "late failed fix"]);
    ok({ messages: [{
      type: "worker_done",
      taskId: "task-existing",
      dispatchId: "dispatch-existing"
    }] });
  } else {
    ok({ messages: [{
      type: "worker_done",
      taskId: "task-new",
      dispatchId: "dispatch-new"
    }] });
  }
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
implementTimeoutMinutes: ${
      mode === "working" ||
      mode === "failed" ||
      mode === "pending-failed" ||
      mode === "pending-failed-race"
        ? 0.001
        : 1
    }
orca:
  cliPath: ${JSON.stringify(fakeOrca)}
  cliPathFallback: ${JSON.stringify(fakeOrca)}
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
    project: {
      github: "owner/repo",
      localPath: worktree,
      orcaRepoId: "repo-1",
      baseRef: "origin/main",
      defaultBranch: "main",
    },
    issue: {
      number: 12,
      title: "Recover stale terminal",
      url: "https://example.test/issues/12",
      updatedAt: "2026-07-23T00:00:00Z",
      labels: ["ready-for-agent"],
      blockedBy: [],
    },
    baseRef: "origin/main",
    baseSha,
    implementerProfileId: "codex-default",
  });
  assert.equal(claim.ok, true);
  const hasTask =
    mode === "pending" ||
    mode === "pending-failed" ||
    mode === "pending-failed-race" ||
    mode === "accepted" ||
    mode === "working" ||
    mode === "lock-wait" ||
    mode === "failed" ||
    mode === "late-failed" ||
    mode === "diverged" ||
    mode === "dirty";
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
    dispatch_probe_pending:
      mode === "pending" ||
      mode === "pending-failed" ||
      mode === "pending-failed-race"
        ? 1
        : 0,
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

test("runOnce creates a terminal when an exact role title is ambiguous", (t) => {
  const fixture = createFixture("ambiguous");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, true, result.message);
  const dispatches = readCalls(fixture.callsPath).filter(
    (args) =>
      args[0] === "orchestration" && args[1] === "dispatch",
  );
  assert.equal(dispatches.length, 1);
  assert.equal(
    dispatches[0]?.[dispatches[0].indexOf("--to") + 1],
    "implementer-new",
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

test("runOnce blocks when a pending probe accepts the same failed task", (t) => {
  const fixture = createFixture("pending-failed");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /task task-existing is not completed.*failed/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-terminal")?.state, "blocked");
  assert.equal(verified.getJob("job-terminal")?.dispatch_probe_pending, 0);
  verified.close();
  const calls = readCalls(fixture.callsPath);
  assert.equal(
    calls.some(
      (args) =>
        args[0] === "orchestration" &&
        (args[1] === "task-create" || args[1] === "dispatch"),
    ),
    false,
  );
  assert.equal(
    calls.some(
      (args) => args[0] === "orchestration" && args[1] === "check",
    ),
    false,
  );
});

test("runOnce blocks when a failed pending task commits during its probe", (t) => {
  const fixture = createFixture("pending-failed-race");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const startedAt = Date.now();
  let elapsed = 0;
  t.mock.method(Date, "now", () => startedAt + (elapsed += 30_000));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /HEAD changed before implementation dispatch/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-terminal")?.state, "blocked");
  verified.close();
  const calls = readCalls(fixture.callsPath);
  assert.equal(
    calls.some(
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

test("runOnce revalidates the fixed point after an unlocked idle wait", async (t) => {
  const fixture = createFixture("idle-lock-wait");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const lockPath = join(fixture.dir, "harness.lock");
  const markerPath = join(fixture.dir, "idle-waiting");
  const releasePath = join(fixture.dir, "release-idle");
  const resultPath = join(fixture.dir, "run-result.json");
  const runnerPath = join(fixture.dir, "runner.mjs");
  const runOnceModuleUrl = pathToFileURL(
    join(process.cwd(), "src", "run-once.ts"),
  ).href;
  writeFileSync(
    runnerPath,
    `import { writeFileSync } from "node:fs";
import { runOnce } from ${JSON.stringify(runOnceModuleUrl)};
const result = runOnce({
  configPath: ${JSON.stringify(fixture.configPath)},
  ledgerPath: ${JSON.stringify(fixture.ledgerPath)},
  lockPath: ${JSON.stringify(lockPath)},
});
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
`,
  );

  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: process.cwd(),
  });
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const exitPromise = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );

  await waitForFile(markerPath);
  const competingLock = acquireLock(lockPath);
  if (competingLock.ok) {
    const worktree = join(fixture.dir, "worktree");
    writeFileSync(join(worktree, "value.txt"), "concurrent change\n");
    git(worktree, "add", "value.txt");
    git(worktree, "commit", "-m", "concurrent change");
    competingLock.release();
  }
  writeFileSync(releasePath, "continue");
  const exitCode = await exitPromise;

  assert.equal(
    competingLock.ok,
    true,
    competingLock.error ?? "lock unavailable during terminal idle wait",
  );
  assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
    ok: boolean;
    message: string;
  };
  assert.equal(result.ok, false);
  assert.match(result.message, /HEAD changed before implementation dispatch/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-terminal")?.state, "blocked");
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) => args[0] === "orchestration" && args[1] === "task-create",
    ),
    false,
  );
});

test("runOnce releases dispatch wait lock and preserves newer job facts", async (t) => {
  const fixture = createFixture("dispatch-lock-wait");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const lockPath = join(fixture.dir, "harness.lock");
  const markerPath = join(fixture.dir, "dispatch-waiting");
  const releasePath = join(fixture.dir, "release-dispatch");
  const resultPath = join(fixture.dir, "run-result.json");
  const runnerPath = join(fixture.dir, "runner.mjs");
  const runOnceModuleUrl = pathToFileURL(
    join(process.cwd(), "src", "run-once.ts"),
  ).href;
  writeFileSync(
    runnerPath,
    `import { writeFileSync } from "node:fs";
import { runOnce } from ${JSON.stringify(runOnceModuleUrl)};
const result = runOnce({
  configPath: ${JSON.stringify(fixture.configPath)},
  ledgerPath: ${JSON.stringify(fixture.ledgerPath)},
  lockPath: ${JSON.stringify(lockPath)},
});
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
`,
  );

  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: process.cwd(),
  });
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const exitPromise = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );

  await waitForFile(markerPath);
  const competingLock = acquireLock(lockPath);
  if (competingLock.ok) {
    const concurrent = new Ledger(fixture.ledgerPath);
    concurrent.updateJob("job-terminal", {
      last_error: "newer coordinator fact",
    });
    concurrent.close();
    competingLock.release();
  }
  writeFileSync(releasePath, "continue");
  const exitCode = await exitPromise;

  assert.equal(
    competingLock.ok,
    true,
    competingLock.error ?? "lock unavailable during dispatch acceptance wait",
  );
  assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
    ok: boolean;
    message: string;
  };
  assert.equal(result.ok, false);
  assert.match(result.message, /job changed while waiting for implementation dispatch/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-terminal")?.state, "implementing");
  assert.equal(
    verified.getJob("job-terminal")?.last_error,
    "newer coordinator fact",
  );
  verified.close();
});

test("runOnce releases the PID lock while waiting for worker_done", async (t) => {
  const fixture = createFixture("lock-wait");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const lockPath = join(fixture.dir, "harness.lock");
  const markerPath = join(fixture.dir, "worker-waiting");
  const releasePath = join(fixture.dir, "release-worker");
  const resultPath = join(fixture.dir, "run-result.json");
  const runnerPath = join(fixture.dir, "runner.mjs");
  const runOnceModuleUrl = pathToFileURL(
    join(process.cwd(), "src", "run-once.ts"),
  ).href;
  writeFileSync(
    runnerPath,
    `import { writeFileSync } from "node:fs";
import { runOnce } from ${JSON.stringify(runOnceModuleUrl)};
const result = runOnce({
  configPath: ${JSON.stringify(fixture.configPath)},
  ledgerPath: ${JSON.stringify(fixture.ledgerPath)},
  lockPath: ${JSON.stringify(lockPath)},
});
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
`,
  );

  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: process.cwd(),
  });
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const exitPromise = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );

  await waitForFile(markerPath);
  const competingLock = acquireLock(lockPath);
  if (competingLock.ok) competingLock.release();
  writeFileSync(releasePath, "continue");
  const exitCode = await exitPromise;

  assert.equal(
    competingLock.ok,
    true,
    competingLock.error ?? "lock unavailable during worker wait",
  );
  assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
    ok: boolean;
    message: string;
  };
  assert.equal(result.ok, true, result.message);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-terminal")?.state, "awaiting_audit");
  verified.close();
});

test("runOnce does not finalize commits while the task is still working", (t) => {
  const fixture = createFixture("working");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /task task-existing is not completed.*working/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-terminal")?.state, "blocked");
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) => args[0] === "orchestration" && args[1] === "check",
    ),
    true,
  );
});

test("runOnce blocks a failed task with commits without waiting", (t) => {
  const fixture = createFixture("failed");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /task task-existing is not completed.*failed/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-terminal")?.state, "blocked");
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) => args[0] === "orchestration" && args[1] === "check",
    ),
    false,
  );
});

test("runOnce does not accept worker_done after the task becomes failed", (t) => {
  const fixture = createFixture("late-failed");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /task task-existing is not completed.*failed/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-terminal")?.state, "blocked");
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) => args[0] === "orchestration" && args[1] === "check",
    ),
    true,
  );
});

test("runOnce does not finalize completed task commits when tracked files are dirty", (t) => {
  const fixture = createFixture("dirty");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /tracked files dirty/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-terminal")?.state, "blocked");
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) => args[0] === "orchestration" && args[1] === "check",
    ),
    false,
  );
});

test("runOnce blocks a completed task whose HEAD diverged from base", (t) => {
  const fixture = createFixture("diverged");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /not a descendant of base/i);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-terminal")?.state, "blocked");
  verified.close();
});

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readCalls(path: string): string[][] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
