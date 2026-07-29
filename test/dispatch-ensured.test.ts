import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchTaskEnsured,
  waitWorkerDone,
} from "../src/orca-runtime.js";

test("surfaces decision_gate without replying automatically", () => {
  const fake = makeFakeOrca("decision-then-done");
  const result = waitWorkerDone(fake.command, {
    controllerHandle: "controller-1",
    taskId: "task-1",
    dispatchId: "dispatch-1",
    timeoutMs: 3_000,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(
    result.error,
    "worker requested a human decision (message gate-1)",
  );
  assert.equal(result.intervention?.kind, "decision_gate");
  assert.equal(result.intervention?.messageId, "gate-1");
  const lifecycleCalls = fake.calls().filter(
    (args) =>
      args[0] === "orchestration" &&
      (args[1] === "check" || args[1] === "reply"),
  );
  assert.deepEqual(
    lifecycleCalls.map((args) => args[1]),
    ["check"],
  );
});

test("fails decision_gate without a top-level message id", () => {
  const fake = makeFakeOrca("decision-missing-id");
  const result = waitWorkerDone(fake.command, {
    controllerHandle: "controller-1",
    taskId: "task-1",
    dispatchId: "dispatch-1",
    timeoutMs: 1_000,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(
    result.error,
    "decision_gate missing message id for task task-1",
  );
  assert.deepEqual(result.message, {
    type: "decision_gate",
    taskId: "task-1",
    dispatchId: "dispatch-1",
    payload: { id: "payload-gate-1" },
  });
  const calls = fake.calls();
  assert.equal(
    calls.filter(
      (args) =>
        args[0] === "orchestration" && args[1] === "reply",
    ).length,
    0,
  );
  assert.equal(
    calls.filter(
      (args) =>
        args[0] === "orchestration" && args[1] === "check",
    ).length,
    1,
  );
});

test("does not attempt a reply when a decision_gate arrives", () => {
  const fake = makeFakeOrca("decision-reply-fails");
  const result = waitWorkerDone(fake.command, {
    controllerHandle: "controller-1",
    taskId: "task-1",
    dispatchId: "dispatch-1",
    timeoutMs: 3_000,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(
    result.error,
    "worker requested a human decision (message gate-1)",
  );
  assert.deepEqual(result.message, {
    id: "gate-1",
    type: "decision_gate",
    taskId: "task-1",
    dispatchId: "dispatch-1",
  });
  assert.equal(
    fake.calls().filter(
      (args) =>
        args[0] === "orchestration" && args[1] === "reply",
    ).length,
    0,
  );
});

test("an exact worker_done wins over an older escalation in the same inbox batch", () => {
  const fake = makeFakeOrca("escalation-and-done");
  const result = waitWorkerDone(fake.command, {
    controllerHandle: "controller-1",
    taskId: "task-1",
    dispatchId: "dispatch-1",
    timeoutMs: 1_000,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.message.type, "worker_done");
});

test("ignores stale, malformed, conflicting, or wrong-type completion payloads", () => {
  const fake = makeFakeOrca("stale-string-then-done");
  const result = waitWorkerDone(fake.command, {
    controllerHandle: "controller-1",
    taskId: "task-current",
    dispatchId: "dispatch-current",
    timeoutMs: 10_000,
  });

  assert.equal(result.ok, true);
  assert.equal(
    fake
      .calls()
      .filter(
        (args) =>
          args[0] === "orchestration" && args[1] === "check",
      ).length,
    6,
  );
});

test("accepts task provenance alone for a legacy dispatch without an id", () => {
  const fake = makeFakeOrca("task-only-done");
  const result = waitWorkerDone(fake.command, {
    controllerHandle: "controller-1",
    taskId: "task-current",
    dispatchId: null,
    timeoutMs: 1_000,
  });

  assert.equal(result.ok, true);
});

test("rejects a dispatch response without a dispatch id", () => {
  const fake = makeFakeOrca("missing-dispatch-id");
  const result = dispatchTaskEnsured(fake.command, {
    title: "Implement example#1",
    displayName: "issue-1-implement",
    spec: "do the work",
    to: "term-1",
    from: "controller-1",
    probeTimeoutMs: 0,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /missing dispatchId/);
  if (!result.ok) {
    assert.equal(result.lastTaskId, "task-1");
    assert.equal(result.lastDispatchId, null);
    assert.equal(result.lastAttempt, 1);
  }
});

test("rejects a non-string dispatch id", () => {
  const fake = makeFakeOrca("wrong-dispatch-id-type");
  const result = dispatchTaskEnsured(fake.command, {
    title: "Implement example#1",
    displayName: "issue-1-implement",
    spec: "do the work",
    to: "term-1",
    from: "controller-1",
    probeTimeoutMs: 0,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /missing dispatchId/);
  if (!result.ok) {
    assert.equal(result.lastTaskId, "task-1");
    assert.equal(result.lastDispatchId, null);
    assert.equal(result.lastAttempt, 1);
  }
});

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
  if (!result.ok) {
    assert.equal(result.lastTaskId, "task-1");
    assert.equal(result.lastDispatchId, "dispatch-1");
    assert.equal(result.lastAttempt, 1);
  }
  assert.equal(
    fake.calls().filter(
      (args) => args[0] === "orchestration" && args[1] === "task-create",
    ).length,
    1,
  );
});

test("reports the second attempt provenance as one tuple", () => {
  const fake = makeFakeOrca("silent-idle");
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
  if (!result.ok) {
    assert.equal(result.lastTaskId, "task-2");
    assert.equal(result.lastDispatchId, "dispatch-2");
    assert.equal(result.lastAttempt, 2);
  }
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
    | "existing-task"
    | "decision-then-done"
    | "decision-missing-id"
    | "decision-reply-fails"
    | "stale-string-then-done"
    | "task-only-done"
    | "missing-dispatch-id"
    | "wrong-dispatch-id-type",
): {
  command: string;
  calls: () => string[][];
} {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-orca-"));
  const command = join(dir, "orca.cjs");
  const callsPath = join(dir, "calls.jsonl");
  writeFileSync(join(dir, "mode"), mode);
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ waits: 0, tasks: 0, checks: 0 }),
  );
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
    mode === "existing-task" ||
    mode === "missing-dispatch-id" ||
    mode === "wrong-dispatch-id-type"
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
  console.log(JSON.stringify({
    ok: true,
    result: mode === "missing-dispatch-id"
      ? {}
      : mode === "wrong-dispatch-id-type"
        ? { dispatchId: ["dispatch-" + state.tasks] }
      : { dispatchId: "dispatch-" + state.tasks }
  }));
} else if (key === "orchestration task-update") {
  if (mode === "task-update-fails") {
    console.log(JSON.stringify({ ok: false, error: { message: "task update unavailable" } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, result: {} }));
  }
} else if (key === "orchestration reply") {
  if (mode === "decision-reply-fails") {
    console.log(JSON.stringify({ ok: false, error: { message: "reply unavailable" } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, result: {} }));
  }
} else if (
  key === "orchestration check" &&
  (mode === "decision-then-done" || mode === "decision-reply-fails")
) {
  state.checks += 1;
  writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify({ ok: true, result: { messages: [{
    ...(state.checks === 1 ? { id: "gate-1" } : {}),
    type: state.checks === 1 ? "decision_gate" : "worker_done",
    taskId: "task-1",
    dispatchId: "dispatch-1"
  }] } }));
} else if (key === "orchestration check" && mode === "decision-missing-id") {
  console.log(JSON.stringify({ ok: true, result: { messages: [{
    type: "decision_gate",
    taskId: "task-1",
    dispatchId: "dispatch-1",
    payload: { id: "payload-gate-1" }
  }] } }));
} else if (key === "orchestration check" && mode === "escalation-and-done") {
  console.log(JSON.stringify({ ok: true, result: { messages: [
    { id: "escalation-1", type: "escalation", taskId: "task-1", dispatchId: "dispatch-1" },
    { type: "worker_done", taskId: "task-1", dispatchId: "dispatch-1" }
  ] } }));
} else if (key === "orchestration check" && mode === "stale-string-then-done") {
  state.checks += 1;
  writeFileSync(statePath, JSON.stringify(state));
  const payload =
    state.checks === 1
      ? JSON.stringify({ taskId: "task-old", dispatchId: "dispatch-old" })
      : state.checks === 2
        ? "{"
      : state.checks === 3
          ? "{}"
          : state.checks === 4
            ? JSON.stringify({
                taskId: ["task-current"],
                dispatchId: ["dispatch-current"]
              })
            : state.checks === 5
              ? JSON.stringify({ taskId: "task-old", dispatchId: "dispatch-old" })
              : JSON.stringify({ taskId: "task-current", dispatchId: "dispatch-current" });
  const message = {
    type: state.checks === 4 ? ["worker_done"] : "worker_done",
    payload
  };
  if (state.checks === 5) {
    message.taskId = "task-current";
    message.dispatchId = "dispatch-current";
  }
  console.log(JSON.stringify({ ok: true, result: { messages: [message] } }));
} else if (key === "orchestration check" && mode === "task-only-done") {
  console.log(JSON.stringify({ ok: true, result: { messages: [{
    type: "worker_done",
    taskId: "task-current"
  }] } }));
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
