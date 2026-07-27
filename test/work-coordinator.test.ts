import test from "node:test";
import assert from "node:assert/strict";
import { WorkCoordinator } from "../src/work.js";
import type { RecoverResult } from "../src/recover.js";
import type { RecoverAction } from "../src/reconcile.js";
import type { JobState } from "../src/types.js";

const explicitRetry: RecoverResult = {
  ok: true,
  message: "implementation retry requires explicit recovery",
  action: {
    kind: "retry_implement",
    reason: "implementation retry requires explicit recovery",
  },
  jobId: "job-1",
  details: { state: "blocked" },
  executed: false,
};

test("automatic cycle never executes an explicit implementation retry", () => {
  let executeCalls = 0;
  const coordinator = new WorkCoordinator({
    recover: (options) => {
      if (!options.dryRun) executeCalls += 1;
      return explicitRetry;
    },
  });

  const result = coordinator.cycle({ mode: "automatic" });

  assert.equal(result.plan.execution, "explicit_recovery");
  assert.equal(result.executed, false);
  assert.equal(executeCalls, 0);
});

test("automatic policy is enforced again by the executing inspection", () => {
  const coordinator = new WorkCoordinator({
    recover: (options) => {
      if (options.dryRun) {
        return {
          ok: true,
          message: "awaiting audit",
          action: { kind: "audit_once", reason: "awaiting audit" },
          jobId: "job-1",
          details: { state: "awaiting_audit" },
          executed: false,
        };
      }

      const mode = (options as { mode?: string }).mode;
      return {
        ...explicitRetry,
        executed: mode !== "automatic",
      };
    },
  });

  const result = coordinator.cycle({ mode: "automatic" });

  assert.equal(result.plan.execution, "automatic");
  assert.equal(result.executed, false);
  assert.equal(result.result?.action.kind, "retry_implement");
});

test("inspect classifies automatic work, explicit recovery, and stopping states", () => {
  const cases: Array<{
    name: string;
    state?: JobState;
    action: RecoverAction;
    expected: "automatic" | "explicit_recovery" | "none";
  }> = [
    {
      name: "no active job",
      action: { kind: "none", reason: "claim next" },
      expected: "automatic",
    },
    {
      name: "normal implementation",
      state: "claimed",
      action: { kind: "run_once", reason: "implement" },
      expected: "automatic",
    },
    {
      name: "normal audit",
      state: "awaiting_audit",
      action: { kind: "audit_once", reason: "audit" },
      expected: "automatic",
    },
    {
      name: "blocked audit recovery",
      state: "blocked",
      action: { kind: "audit_once", reason: "resume blocked audit" },
      expected: "explicit_recovery",
    },
    {
      name: "blocked implementation finalization",
      state: "blocked",
      action: { kind: "finalize_implement", reason: "finalize" },
      expected: "explicit_recovery",
    },
    {
      name: "newly detected block",
      state: "implementing",
      action: { kind: "blocked", reason: "bad lineage", persist: true },
      expected: "automatic",
    },
    {
      name: "stable block",
      state: "blocked",
      action: { kind: "blocked", reason: "human action required" },
      expected: "none",
    },
    {
      name: "terminal job",
      state: "merged",
      action: { kind: "noop", reason: "terminal" },
      expected: "none",
    },
  ];

  for (const entry of cases) {
    const coordinator = new WorkCoordinator({
      recover: () => ({
        ok: true,
        message: entry.action.reason,
        action: entry.action,
        jobId: entry.state ? "job-1" : undefined,
        details: { state: entry.state ?? null },
        executed: false,
      }),
    });

    assert.equal(coordinator.inspect().execution, entry.expected, entry.name);
  }
});

test("automatic cycle executes one normal ensure action", () => {
  let executeCalls = 0;
  const coordinator = new WorkCoordinator({
    recover: (options) => {
      const executed = !options.dryRun;
      if (executed) executeCalls += 1;
      return {
        ok: true,
        message: "awaiting_audit: run dual-axis audit",
        action: {
          kind: "audit_once",
          reason: "awaiting_audit: run dual-axis audit",
        },
        jobId: "job-1",
        details: { state: "awaiting_audit" },
        executed,
      };
    },
  });

  const result = coordinator.cycle({ mode: "automatic" });

  assert.equal(result.plan.execution, "automatic");
  assert.equal(result.executed, true);
  assert.equal(result.result?.action.kind, "audit_once");
  assert.equal(executeCalls, 1);
});

test("automatic cycle claims through run-once when no job is active", () => {
  let recoverExecuteCalls = 0;
  let runOnceCalls = 0;
  const coordinator = new WorkCoordinator({
    recover: (options) => {
      if (!options.dryRun) recoverExecuteCalls += 1;
      return {
        ok: true,
        message: "no active job",
        action: { kind: "none", reason: "no active job" },
        details: { state: null },
        executed: false,
      };
    },
    runOnce: (options) => {
      assert.equal(
        (options as { automaticCoordination?: boolean })
          .automaticCoordination,
        true,
      );
      runOnceCalls += 1;
      return {
        ok: true,
        jobId: "job-2",
        message: "implementation dispatched",
        details: { state: "implementing" },
      };
    },
  });

  const result = coordinator.cycle({ mode: "automatic" });

  assert.equal(result.plan.execution, "automatic");
  assert.equal(result.executed, true);
  assert.equal(result.result?.jobId, "job-2");
  assert.equal(runOnceCalls, 1);
  assert.equal(recoverExecuteCalls, 0);
});

test("explicit recovery does not claim when no job is active", () => {
  let runOnceCalls = 0;
  const coordinator = new WorkCoordinator({
    recover: () => ({
      ok: true,
      message: "no active job",
      action: { kind: "none", reason: "no active job" },
      details: { state: null },
      executed: false,
    }),
    runOnce: () => {
      runOnceCalls += 1;
      return {
        ok: true,
        jobId: "unexpected",
        message: "unexpected claim",
      };
    },
  });

  const result = coordinator.cycle({ mode: "explicit_recovery" });

  assert.equal(result.plan.action.kind, "none");
  assert.equal(result.executed, false);
  assert.equal(runOnceCalls, 0);
});

test("run stops before an explicit recovery plan", () => {
  let stage: "audit" | "blocked" = "audit";
  let executeCalls = 0;
  const coordinator = new WorkCoordinator({
    recover: (options) => {
      if (stage === "blocked") return explicitRetry;
      const result: RecoverResult = {
        ok: true,
        message: "run audit",
        action: { kind: "audit_once", reason: "run audit" },
        jobId: "job-1",
        details: { state: "awaiting_audit" },
        executed: !options.dryRun,
      };
      if (!options.dryRun) {
        executeCalls += 1;
        stage = "blocked";
      }
      return result;
    },
  });

  const result = coordinator.run({ maxCycles: 5 });

  assert.equal(result.cycles, 2);
  assert.equal(result.last.plan.execution, "explicit_recovery");
  assert.equal(result.last.executed, false);
  assert.equal(executeCalls, 1);
});
