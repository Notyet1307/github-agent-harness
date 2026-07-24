import test from "node:test";
import assert from "node:assert/strict";
import {
  IMPLEMENT_NO_COMMITS_ERROR,
  reconcileJob,
} from "../src/reconcile.js";
import { planWatchCycle } from "../src/watch.js";
import type { Job } from "../src/types.js";

test("none → claim_and_implement", () => {
  const p = planWatchCycle({ kind: "none", reason: "idle" });
  assert.equal(p.step, "claim_and_implement");
});

test("blocked → blocked_wait (do not claim next)", () => {
  const p = planWatchCycle({ kind: "blocked", reason: "stuck" });
  assert.equal(p.step, "blocked_wait");
});

test("implementation retry waits for explicit recover execution", () => {
  const p = planWatchCycle({
    kind: "retry_implement",
    reason: "premature completion",
  });
  assert.equal(p.step, "blocked_wait");
});

test("completed implementation with commits resumes finalization", () => {
  const p = planWatchCycle({
    kind: "finalize_implement",
    reason: "commits landed after completion signal",
  });
  assert.equal(p.step, "resume");
});

test("failed implementation recovery holds the watch slot", () => {
  const action = reconcileJob(
    {
      state: "blocked",
      implementer_task_id: "task-failed",
      last_error: IMPLEMENT_NO_COMMITS_ERROR,
    } as Job,
    {
      worktreeExists: true,
      hasCommitsSinceBase: true,
      trackedClean: true,
      implementTaskStatus: "failed",
    },
  );

  assert.equal(action.kind, "blocked");
  assert.equal(planWatchCycle(action).step, "blocked_wait");
});

test("run_once/audit/publish/wait_merge → resume", () => {
  for (const kind of [
    "run_once",
    "audit_once",
    "publish_once",
    "wait_merge",
  ] as const) {
    const p = planWatchCycle({ kind, reason: "x" });
    assert.equal(p.step, "resume", kind);
  }
});

test("noop → noop_sleep", () => {
  const p = planWatchCycle({ kind: "noop", reason: "merged" });
  assert.equal(p.step, "noop_sleep");
});
