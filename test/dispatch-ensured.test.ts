import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTaskEnsured } from "../src/orca-runtime.js";

test("requires tui-idle before creating an orchestration task", () => {
  const fake = makeFakeOrca("not-idle");
  const result = dispatchTaskEnsured(fake.command, {
    title: "Implement example#1",
    displayName: "issue-1-implement",
    spec: "do the work",
    to: "term-1",
    from: "controller-1",
    probeTimeoutMs: 0,
  });

  assert.equal(result.ok, false);
  assert.equal(
    fake.calls().some((args) => args[0] === "orchestration" && args[1] === "task-create"),
    false,
  );
});

test("does not assume idle when Orca omits wait.satisfied", () => {
  const fake = makeFakeOrca("wait-missing-satisfied");
  const result = dispatchTaskEnsured(fake.command, {
    title: "Implement example#1",
    displayName: "issue-1-implement",
    spec: "do the work",
    to: "term-1",
    from: "controller-1",
    probeTimeoutMs: 0,
  });

  assert.equal(result.ok, false);
  assert.equal(
    fake.calls().some(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ),
    false,
  );
});

test("accepts fresh Working output read from the pre-dispatch cursor", () => {
  const fake = makeFakeOrca("cursor-working");
  const result = dispatchTaskEnsured(fake.command, {
    title: "Implement example#1",
    displayName: "issue-1-implement",
    spec: "do the work",
    to: "term-1",
    from: "controller-1",
    probeTimeoutMs: 50,
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.attempt, 1);
  assert.equal(
    fake.calls().some((args) => args[0] === "terminal" && args[1] === "read" && args.includes("--cursor")),
    true,
  );
});

test("does not fail or redispatch when the post-dispatch probe is unavailable", () => {
  const fake = makeFakeOrca("probe-unknown");
  const result = dispatchTaskEnsured(fake.command, {
    title: "Implement example#1",
    displayName: "issue-1-implement",
    spec: "do the work",
    to: "term-1",
    from: "controller-1",
    probeTimeoutMs: 50,
  });

  assert.equal(result.ok, false);
  const calls = fake.calls();
  assert.equal(
    calls.filter((args) => args[0] === "orchestration" && args[1] === "task-create").length,
    1,
  );
  assert.equal(
    calls.filter((args) => args[0] === "orchestration" && args[1] === "task-update").length,
    0,
  );
});

test("does not reuse the old terminal when recreation fails", () => {
  const fake = makeFakeOrca("silent-idle");
  const result = dispatchTaskEnsured(fake.command, {
    title: "Implement example#1",
    displayName: "issue-1-implement",
    spec: "do the work",
    to: "term-1",
    from: "controller-1",
    probeTimeoutMs: 50,
    recreateAgentTerminal: () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(
    fake.calls().filter(
      (args) => args[0] === "orchestration" && args[1] === "task-create",
    ).length,
    1,
  );
});

test("reports every successful dispatch before probing and accepts one retry", () => {
  const fake = makeFakeOrca("silent-then-working");
  const dispatched: Array<{
    taskId: string;
    dispatchId: string | null;
    to: string;
    attempt: 1 | 2;
  }> = [];
  const result = dispatchTaskEnsured(fake.command, {
    title: "Implement example#1",
    displayName: "issue-1-implement",
    spec: "do the work",
    to: "term-1",
    from: "controller-1",
    probeTimeoutMs: 50,
    recreateAgentTerminal: () => "term-2",
    onDispatched: (event) => dispatched.push(event),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.attempt, 2);
    assert.equal(result.to, "term-2");
  }
  assert.deepEqual(dispatched, [
    { taskId: "task-1", dispatchId: "dispatch-1", to: "term-1", attempt: 1 },
    { taskId: "task-2", dispatchId: "dispatch-2", to: "term-2", attempt: 2 },
  ]);
  assert.equal(
    fake.calls().filter(
      (args) => args[0] === "orchestration" && args[1] === "task-update",
    ).length,
    1,
  );
});

test("does not redispatch when the first task cannot be marked failed", () => {
  const fake = makeFakeOrca("task-update-fails");
  const result = dispatchTaskEnsured(fake.command, {
    title: "Implement example#1",
    displayName: "issue-1-implement",
    spec: "do the work",
    to: "term-1",
    from: "controller-1",
    probeTimeoutMs: 50,
    recreateAgentTerminal: () => "term-2",
  });

  assert.equal(result.ok, false);
  assert.equal(
    fake.calls().filter(
      (args) => args[0] === "orchestration" && args[1] === "task-create",
    ).length,
    1,
  );
});

test("resumes a persisted dispatch without creating another task", () => {
  const fake = makeFakeOrca("existing-task");
  const result = dispatchTaskEnsured(fake.command, {
    title: "Implement example#1",
    displayName: "issue-1-implement",
    spec: "do the work",
    to: "term-1",
    from: "controller-1",
    probeTimeoutMs: 50,
    existingDispatch: {
      taskId: "task-existing",
      dispatchId: "dispatch-existing",
      to: "term-1",
      attempt: 1,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.taskId, "task-existing");
  assert.equal(
    fake.calls().filter(
      (args) => args[0] === "orchestration" && args[1] === "task-create",
    ).length,
    0,
  );
});

function makeFakeOrca(
  mode:
    | "not-idle"
    | "wait-missing-satisfied"
    | "cursor-working"
    | "probe-unknown"
    | "silent-idle"
    | "silent-then-working"
    | "task-update-fails"
    | "existing-task",
): {
  command: string;
  calls: () => string[][];
} {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-orca-"));
  const command = join(dir, "orca.cjs");
  const callsPath = join(dir, "calls.jsonl");
  writeFileSync(join(dir, "mode"), mode);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ waits: 0, tasks: 0 }));
  writeFileSync(
    command,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const dir = dirname(process.argv[1]);
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify(args) + "\\n");
const mode = readFileSync(join(dir, "mode"), "utf8");
const statePath = join(dir, "state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const key = args.slice(0, 2).join(" ");
if (key === "terminal wait") {
  state.waits += 1;
  writeFileSync(statePath, JSON.stringify(state));
  if (
    mode === "silent-idle" ||
    mode === "silent-then-working" ||
    mode === "task-update-fails" ||
    mode === "existing-task"
  ) {
    console.log(JSON.stringify({ ok: true, result: { wait: { satisfied: true, status: "idle", blockedReason: null } } }));
  } else if ((mode === "cursor-working" || mode === "probe-unknown") && state.waits === 1) {
    console.log(JSON.stringify({ ok: true, result: { wait: { satisfied: true, status: "idle", blockedReason: null } } }));
  } else if (mode === "not-idle") {
    console.log(JSON.stringify({ ok: true, result: { wait: { satisfied: false, status: "running", blockedReason: null } } }));
    process.exitCode = 1;
  } else if (mode === "wait-missing-satisfied") {
    console.log(JSON.stringify({ ok: true, result: { wait: { status: "idle", blockedReason: null } } }));
  } else {
    console.log(JSON.stringify({ ok: false, error: { message: "wait unavailable" } }));
    process.exitCode = 1;
  }
} else if (key === "terminal read") {
  const cursorIndex = args.indexOf("--cursor");
  const fresh = cursorIndex !== -1;
  if (mode === "probe-unknown" && fresh) {
    console.log(JSON.stringify({ ok: false, error: { message: "read unavailable" } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, result: { terminal: {
      tail:
        mode === "existing-task"
          ? ["Your task ID is: task-existing"]
          :
        mode === "probe-unknown" ||
        mode === "silent-idle" ||
        mode === "task-update-fails" ||
        (mode === "silent-then-working" && (!fresh || args[args.indexOf("--terminal") + 1] === "term-1"))
          ? []
          : [fresh ? "Working..." : "old Working from task_previous"],
      nextCursor: fresh ? "11" : "10",
      latestCursor: fresh ? "11" : "10"
    } } }));
  }
} else if (key === "terminal show") {
  if (mode === "probe-unknown") {
    console.log(JSON.stringify({ ok: false, error: { message: "show unavailable" } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, result: { terminal: { title: "pi", preview: "" } } }));
  }
} else if (key === "orchestration task-create") {
  state.tasks += 1;
  writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify({ ok: true, result: { taskId: "task-" + state.tasks } }));
} else if (key === "orchestration dispatch") {
  console.log(JSON.stringify({ ok: true, result: { dispatchId: "dispatch-" + state.tasks } }));
} else if (key === "orchestration task-update") {
  if (mode === "task-update-fails") {
    console.log(JSON.stringify({ ok: false, error: { message: "task update unavailable" } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, result: {} }));
  }
} else {
  console.log(JSON.stringify({ ok: false, error: { message: "unexpected " + key } }));
  process.exitCode = 1;
}
`,
  );
  chmodSync(command, 0o755);
  return {
    command,
    calls: () =>
      readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}
