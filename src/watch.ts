import { defaultLedgerPath, loadConfig } from "./config.js";
import { execFile } from "./exec.js";
import type { RecoverAction } from "./reconcile.js";
import {
  notifyActiveIntervention,
  notifyStatusEvent,
  type NotificationResult,
} from "./notification.js";
import { Ledger } from "./ledger.js";
import type { Job, StatusNotificationEvent } from "./types.js";
import {
  WorkCoordinator,
  type WorkCycleResult,
} from "./work.js";

export type WatchCyclePlan = {
  /** What this cycle intends to do. */
  step:
    | "idle_sleep"
    | "claim_and_implement"
    | "resume"
    | "blocked_wait"
    | "noop_sleep";
  action: RecoverAction;
  reason: string;
};

export type WatchCycleResult = {
  plan: WatchCyclePlan;
  result?: WorkCycleResult["result"];
  notification?: NotificationResult;
  statusNotification?: NotificationResult;
  sleptSeconds: number;
};

/**
 * Pure planner for one watch tick (testable without Orca).
 */
export function planWatchCycle(action: RecoverAction): WatchCyclePlan {
  switch (action.kind) {
    case "none":
      return {
        step: "claim_and_implement",
        action,
        reason: "no active job → try claim + implement",
      };
    case "noop":
      return {
        step: "noop_sleep",
        action,
        reason: action.reason,
      };
    case "blocked":
      if (action.persist) {
        return {
          step: "resume",
          action,
          reason: `record newly detected block: ${action.reason}`,
        };
      }
      return {
        step: "blocked_wait",
        action,
        reason: `blocked job holds the slot: ${action.reason}`,
      };
    case "retry_implement":
      return {
        step: "blocked_wait",
        action,
        reason: `blocked job holds the slot: ${action.reason}`,
      };
    case "resolve_intervention":
      return {
        step: "blocked_wait",
        action,
        reason: `human ${action.intervention} required: ${action.reason}`,
      };
    case "run_once":
    case "finalize_implement":
    case "audit_once":
    case "publish_once":
    case "wait_merge":
      return {
        step: "resume",
        action,
        reason: `resume via ${action.kind}: ${action.reason}`,
      };
    default:
      return {
        step: "idle_sleep",
        action,
        reason: "unknown action",
      };
  }
}

export type WatchOptions = {
  configPath?: string;
  /** Run a single cycle then exit. */
  once?: boolean;
  /** Stop after N cycles (0 = forever). */
  maxCycles?: number;
  /** If true, only plan + log; do not call agents / push / PR. */
  dryRun?: boolean;
  /** Override poll interval seconds. */
  pollSeconds?: number;
  /** Stop flag checked each cycle (for tests / signals). */
  shouldStop?: () => boolean;
  log?: (line: string) => void;
};

/**
 * Continuous loop: reconcile → ensure* resume → or claim next → sleep.
 * Auto mode requests GitHub auto-merge; blocked jobs do not free the slot.
 */
export function watch(options: WatchOptions = {}): {
  ok: boolean;
  cycles: number;
  message: string;
} {
  const log =
    options.log ??
    ((line: string) => {
      process.stdout.write(`[watch] ${line}\n`);
    });

  const config = loadConfig(options.configPath);
  const coordinator = new WorkCoordinator();
  const pollSeconds = Math.max(
    5,
    options.pollSeconds ?? config.pollIntervalSeconds ?? 120,
  );
  const maxCycles = options.maxCycles ?? 0;
  let cycles = 0;
  let stop = false;

  const onSigInt = () => {
    log("received SIGINT; stopping after current cycle");
    stop = true;
  };
  const onSigTerm = () => {
    log("received SIGTERM; stopping after current cycle");
    stop = true;
  };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  log(
    `starting (poll=${pollSeconds}s dryRun=${Boolean(options.dryRun)} once=${Boolean(options.once)})`,
  );

  try {
    while (!stop && !(options.shouldStop?.() ?? false)) {
      cycles += 1;
      log(`── cycle ${cycles} ──`);

      const cycle = runWatchCycle({
        coordinator,
        configPath: options.configPath,
        dryRun: options.dryRun,
        log,
      });

      if (options.once) {
        log(`once mode: exiting after cycle ${cycles}`);
        return {
          ok: true,
          cycles,
          message: cycle.plan.reason,
        };
      }
      if (maxCycles > 0 && cycles >= maxCycles) {
        log(`max-cycles=${maxCycles} reached`);
        return { ok: true, cycles, message: "max-cycles reached" };
      }

      if (stop || (options.shouldStop?.() ?? false)) break;

      log(`sleep ${pollSeconds}s`);
      sleepSeconds(pollSeconds);
    }
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }

  return { ok: true, cycles, message: "stopped" };
}

export function runWatchCycle(opts: {
  coordinator: WorkCoordinator;
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  dryRun?: boolean;
  log: (line: string) => void;
  notifyIntervention?: typeof notifyActiveIntervention;
  notifyStatus?: typeof notifyStatusEvent;
}): WatchCycleResult {
  const before = readActiveJob(opts.ledgerPath);
  const coordinated = opts.coordinator.cycle({
    mode: "automatic",
    configPath: opts.configPath,
    ledgerPath: opts.ledgerPath,
    lockPath: opts.lockPath,
    dryRun: opts.dryRun,
  });
  const plan = planWatchCycle(coordinated.plan.action);
  opts.log(`plan: ${plan.step} — ${plan.reason}`);

  let notification: NotificationResult | undefined;
  if (
    coordinated.plan.action.kind === "resolve_intervention" ||
    plan.step === "blocked_wait" ||
    // A long-running action can transition the job to blocked after the plan
    // was inspected. Notify in that same cycle instead of waiting for a later
    // poll (or silently missing a crashed provider worker).
    coordinated.result?.ok === false
  ) {
    notification = (opts.notifyIntervention ?? notifyActiveIntervention)({
      configPath: opts.configPath,
      ledgerPath: opts.ledgerPath,
      lockPath: opts.lockPath,
      dryRun: opts.dryRun,
    });
    opts.log(
      `notification ${notification.ok ? "ok" : "fail"}: ${notification.message}`,
    );
  }

  const afterSameJob = before ? readJob(opts.ledgerPath, before.id) : null;
  const afterActive = readActiveJob(opts.ledgerPath);
  const statusEvent = lifecycleStatusEvent(before, afterSameJob, afterActive);
  let statusNotification: NotificationResult | undefined;
  if (statusEvent) {
    statusNotification = (opts.notifyStatus ?? notifyStatusEvent)({
      event: statusEvent.event,
      job: statusEvent.job,
      configPath: opts.configPath,
      ledgerPath: opts.ledgerPath,
      lockPath: opts.lockPath,
      dryRun: opts.dryRun,
    });
    if (statusNotification.status !== "disabled") {
      opts.log(`status notification ${statusNotification.ok ? "ok" : "fail"}: ${statusNotification.message}`);
    }
  }

  if (coordinated.result) {
    opts.log(
      `${coordinated.result.ok ? "ok" : "fail"}: ${coordinated.result.message}`,
    );
  } else if (!coordinated.executed) {
    opts.log(plan.reason);
  }

  return {
    plan,
    result: coordinated.result,
    notification,
    statusNotification,
    sleptSeconds: 0,
  };
}

function readActiveJob(ledgerPath?: string): Job | null {
  const ledger = new Ledger(ledgerPath ?? defaultLedgerPath());
  try { return ledger.getActiveJob(); } finally { ledger.close(); }
}

function readJob(ledgerPath: string | undefined, jobId: string): Job | null {
  const ledger = new Ledger(ledgerPath ?? defaultLedgerPath());
  try { return ledger.getJob(jobId); } finally { ledger.close(); }
}

function lifecycleStatusEvent(
  before: Job | null,
  afterSameJob: Job | null,
  afterActive: Job | null,
): { event: StatusNotificationEvent; job: Job } | null {
  if (before && afterSameJob && before.state !== afterSameJob.state) {
    if (afterSameJob.state === "reworking") return { event: "rework_started", job: afterSameJob };
    if (afterSameJob.state === "awaiting_merge" && afterSameJob.pr_url) return { event: "pr_created", job: afterSameJob };
    if (afterSameJob.state === "merged") return { event: "merged", job: afterSameJob };
  }
  if (
    afterActive &&
    (!before || afterActive.id !== before.id) &&
    afterActive.state !== "blocked"
  ) {
    return { event: "issue_claimed", job: afterActive };
  }
  return null;
}

function sleepSeconds(seconds: number): void {
  execFile("sleep", [String(seconds)], {
    timeoutMs: (seconds + 2) * 1000,
  });
}
