import test from "node:test";
import assert from "node:assert/strict";
import { verdictDispatchAccepted } from "../src/dispatch-probe.js";

test("accepts when task id appears in tail", () => {
  const v = verdictDispatchAccepted(
    {
      title: "pi",
      preview: "",
      tailText: "Your task ID is: task_abc123\nYou are a dispatched worker.",
      freshOutput: true,
      observed: true,
      idle: true,
      blockedReason: null,
    },
    "task_abc123",
  );
  assert.equal(v.accepted, true);
});

test("accepts Working text from fresh terminal output", () => {
  const v = verdictDispatchAccepted(
    {
      title: "Pi",
      preview: "",
      tailText: "Working...",
      freshOutput: true,
      observed: true,
      idle: null,
      blockedReason: null,
    },
    "task_x",
  );
  assert.equal(v.accepted, true);
});

test("does not accept a stale Working preview while the tui is idle", () => {
  const v = verdictDispatchAccepted(
    {
      title: "⠋ Pi",
      preview: "Working...",
      tailText: "",
      freshOutput: true,
      observed: true,
      idle: true,
      blockedReason: null,
    },
    "task_x",
  );
  assert.equal(v.accepted, false);
});

test("rejects still-idle with no signals", () => {
  const v = verdictDispatchAccepted(
    {
      title: "Pi ready",
      preview: "Use /skills",
      tailText: "pi v0.81.1\n[Skills]\n  implement",
      freshOutput: true,
      observed: true,
      idle: true,
      blockedReason: null,
    },
    "task_x",
  );
  assert.equal(v.accepted, false);
  assert.match(v.reason, /idle/i);
});

test("rejects codex hooks interactive prompt", () => {
  const v = verdictDispatchAccepted(
    {
      title: "codex",
      preview: "Hooks need review",
      tailText: "Hooks need review  3 hooks are new",
      freshOutput: true,
      observed: true,
      idle: false,
      blockedReason: "codex-interactive-prompt",
    },
    "task_x",
  );
  assert.equal(v.accepted, false);
  if (!v.accepted) assert.equal(v.interactive, true);
});

test("accepts non-idle tui without interactive block", () => {
  const v = verdictDispatchAccepted(
    {
      title: "codex",
      preview: "thinking",
      tailText: "planning implementation",
      freshOutput: true,
      observed: true,
      idle: false,
      blockedReason: null,
    },
    "task_x",
  );
  assert.equal(v.accepted, true);
});

test("ignores generic acceptance signals from terminal history", () => {
  const v = verdictDispatchAccepted(
    {
      title: "pi",
      preview: "",
      tailText: "You are a dispatched worker.\nWorking...",
      idle: true,
      blockedReason: null,
      freshOutput: false,
      observed: true,
    },
    "task_current",
  );
  assert.equal(v.accepted, false);
});

test("accepts the current task id even when only retained output is available", () => {
  const v = verdictDispatchAccepted(
    {
      title: "pi",
      preview: "",
      tailText: "Your task ID is: task_current",
      idle: true,
      blockedReason: null,
      freshOutput: false,
      observed: true,
    },
    "task_current",
  );
  assert.equal(v.accepted, true);
});

test("does not match a task id that is only a prefix of another task id", () => {
  const verdict = verdictDispatchAccepted(
    {
      title: "pi",
      preview: "",
      tailText: "Your task ID is: task-10",
      freshOutput: false,
      observed: true,
      idle: true,
      blockedReason: null,
    },
    "task-1",
  );

  assert.equal(verdict.accepted, false);
});

test("does not treat provider wording in the dispatched task as a startup failure", () => {
  const verdict = verdictDispatchAccepted(
    {
      title: "pi",
      preview: "",
      tailText:
        "Requirement: provider/model errors are retryable\nWorking on task task-1",
      freshOutput: true,
      observed: true,
      idle: false,
      blockedReason: null,
    },
    "task-1",
  );

  assert.equal(verdict.accepted, true);
});

test("does not treat hook or version phrases in the task body as startup failures", () => {
  const verdict = verdictDispatchAccepted(
    {
      title: "pi",
      preview: "",
      tailText:
        "Task: handle Hooks need review and Codex version too low safely\nWorking...",
      freshOutput: true,
      observed: true,
      idle: false,
      blockedReason: null,
    },
    "task-1",
  );

  assert.equal(verdict.accepted, true);
});

test("classifies provider or model startup errors as retryable", () => {
  const v = verdictDispatchAccepted(
    {
      title: "pi",
      preview: "",
      tailText: "Provider error: Codex version too low for this model",
      freshOutput: true,
      observed: true,
      idle: true,
      blockedReason: null,
    },
    "task_current",
  );
  assert.equal(v.accepted, false);
  if (!v.accepted) assert.equal(v.retryable, true);
});
