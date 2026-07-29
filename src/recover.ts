import {
  WorkCoordinator,
  type WorkCycleResult,
} from "./work.js";
import type { RecoverResult } from "./recovery.js";

export type { RecoverResult } from "./recovery.js";

/**
 * Compatibility adapter for the legacy recover command.
 * Dry-run remains the safe default at the CLI; execute mode is the only caller
 * allowed to consume plans classified as explicit recovery.
 */
export function recover(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  dryRun?: boolean;
  /** When executing wait_merge, only poll once by default. */
  waitMergeTimeoutMinutes?: number;
  acknowledgeEscalation?: boolean;
  decisionReply?: string;
}): RecoverResult {
  const cycle = new WorkCoordinator().cycle({
    mode: "explicit_recovery",
    configPath: options.configPath,
    ledgerPath: options.ledgerPath,
    lockPath: options.lockPath,
    dryRun: options.dryRun,
    waitMergeTimeoutMinutes: options.waitMergeTimeoutMinutes,
    acknowledgeEscalation: options.acknowledgeEscalation,
    decisionReply: options.decisionReply,
  });
  const executed = recoverResult(cycle);
  if (executed) return executed;

  const action = cycle.plan.action;
  return {
    ok:
      cycle.plan.inspectionOk &&
      action.kind !== "blocked",
    message: cycle.plan.reason,
    action,
    jobId: cycle.plan.jobId,
    details: cycle.plan.details,
    executed: false,
  };
}

function recoverResult(cycle: WorkCycleResult): RecoverResult | null {
  if (cycle.result && "action" in cycle.result) {
    return cycle.result;
  }
  return null;
}
