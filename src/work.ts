import {
  runRecoveryCycle,
  type RecoverResult,
} from "./recovery.js";
import { execFile } from "./exec.js";
import { runOnce, type RunOnceResult } from "./run-once.js";
import {
  classifyRecoverExecution,
  type RecoverAction,
} from "./reconcile.js";
import type { JobState } from "./types.js";

export type WorkPlan = {
  jobId?: string;
  state?: JobState;
  action: RecoverAction;
  execution: "automatic" | "explicit_recovery" | "none";
  reason: string;
  inspectionOk: boolean;
  details?: Record<string, unknown>;
};

export type WorkCycleOptions = {
  mode: "automatic" | "explicit_recovery";
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  repoFilter?: string;
  waitMergeTimeoutMinutes?: number;
  dryRun?: boolean;
  acknowledgeEscalation?: boolean;
  decisionReply?: string;
};

export type WorkCycleResult = {
  plan: WorkPlan;
  result?: RecoverResult | RunOnceResult;
  executed: boolean;
};

export type WorkRunOptions = {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  repoFilter?: string;
  waitMergeTimeoutMinutes?: number;
  dryRun?: boolean;
  once?: boolean;
  maxCycles?: number;
  pollSeconds?: number;
};

export type WorkRunResult = {
  ok: boolean;
  cycles: number;
  message: string;
  last: WorkCycleResult;
};

export class WorkCoordinator {
  private readonly recover: typeof runRecoveryCycle;
  private readonly runOnce: typeof runOnce;
  private readonly sleep: (seconds: number) => void;

  constructor(
    dependencies: {
      recover?: typeof runRecoveryCycle;
      runOnce?: typeof runOnce;
      sleep?: (seconds: number) => void;
    } = {},
  ) {
    this.recover = dependencies.recover ?? runRecoveryCycle;
    this.runOnce = dependencies.runOnce ?? runOnce;
    this.sleep =
      dependencies.sleep ??
      ((seconds) => {
        execFile("sleep", [String(seconds)], {
          timeoutMs: (seconds + 2) * 1000,
        });
      });
  }

  inspect(
    options: Omit<WorkCycleOptions, "mode" | "dryRun"> = {},
  ): WorkPlan {
    const { repoFilter: _repoFilter, ...recoverOptions } = options;
    const inspected = this.recover({ ...recoverOptions, dryRun: true });
    const detailState = inspected.details?.state;
    const state =
      typeof detailState === "string" ? (detailState as JobState) : undefined;
    const execution = classifyRecoverExecution(inspected.action, state);

    return {
      jobId: inspected.jobId,
      state,
      action: inspected.action,
      execution,
      reason: inspected.action.reason,
      inspectionOk: inspected.ok,
      details: inspected.details,
    };
  }

  cycle(options: WorkCycleOptions): WorkCycleResult {
    const { mode, dryRun, ...paths } = options;
    const plan = this.inspect(paths);
    if (
      dryRun ||
      plan.execution === "none" ||
      (plan.execution === "explicit_recovery" && mode === "automatic")
    ) {
      return { plan, executed: false };
    }

    if (plan.action.kind === "none" && mode === "automatic") {
      const { waitMergeTimeoutMinutes: _timeout, ...runOnceOptions } = paths;
      const result = this.runOnce({
        ...runOnceOptions,
        automaticCoordination: true,
      });
      return { plan, result, executed: true };
    }
    if (plan.action.kind === "none") {
      return { plan, executed: false };
    }

    const { repoFilter: _repoFilter, ...recoverPaths } = paths;
    const result = this.recover({ ...recoverPaths, dryRun: false, mode });
    return { plan, result, executed: Boolean(result.executed) };
  }

  run(options: WorkRunOptions = {}): WorkRunResult {
    const { once, maxCycles = 0, pollSeconds = 0, ...cycleOptions } = options;
    let cycles = 0;
    let last: WorkCycleResult;

    for (;;) {
      last = this.cycle({
        ...cycleOptions,
        mode: "automatic",
      });
      cycles += 1;

      const reachedLimit = once || (maxCycles > 0 && cycles >= maxCycles);
      const failed = last.result?.ok === false;
      const waitingForMerge = last.plan.action.kind === "wait_merge";
      if (reachedLimit || failed || waitingForMerge || !last.executed) {
        return {
          ok: !failed && last.plan.execution !== "explicit_recovery",
          cycles,
          message: last.result?.message ?? last.plan.reason,
          last,
        };
      }

      if (pollSeconds > 0) this.sleep(pollSeconds);
    }
  }
}
