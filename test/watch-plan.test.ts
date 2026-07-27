import test from "node:test";
import assert from "node:assert/strict";
import {
  IMPLEMENT_NO_COMMITS_ERROR,
  reconcileJob,
} from "../src/reconcile.js";
import { planWatchCycle, runWatchCycle } from "../src/watch.js";
import { WorkCoordinator } from "../src/work.js";
import type { Job } from "../src/types.js";

test("none → claim_and_implement", () => {
  const p = planWatchCycle({ kind: "none", reason: "idle" });
  assert.equal(p.step, "claim_and_implement");
});

test("blocked → blocked_wait (do not claim next)", () => {
  const p = planWatchCycle({ kind: "blocked", reason: "stuck" });
  assert.equal(p.step, "blocked_wait");
});

test("a newly detected block is persisted before waiting", () => {
  const p = planWatchCycle({
    kind: "blocked",
    reason: "pinned base ancestry is unknown",
    persist: true,
  });
  assert.equal(p.step, "resume");
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

test("watch adapter consumes exactly one coordinator action per tick", () => {
  let runOnceCalls = 0;
  let recoveryExecuteCalls = 0;
  const coordinator = new WorkCoordinator({
    recover: (options) => {
      if (!options.dryRun) recoveryExecuteCalls += 1;
      return {
        ok: true,
        message: "no active job",
        action: { kind: "none", reason: "no active job" },
        details: { state: null },
        executed: false,
      };
    },
    runOnce: () => {
      runOnceCalls += 1;
      return {
        ok: true,
        jobId: "job-1",
        message: "implementation complete",
        details: { state: "awaiting_audit" },
      };
    },
  });

  const cycle = runWatchCycle({
    coordinator,
    log: () => {},
  });

  assert.equal(cycle.plan.step, "claim_and_implement");
  assert.equal(runOnceCalls, 1);
  assert.equal(recoveryExecuteCalls, 0);
});
