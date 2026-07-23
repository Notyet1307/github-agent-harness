import { loadConfig } from "./config.js";
import { recover, type RecoverResult } from "./recover.js";
import { runOnce } from "./run-once.js";
import { execFile } from "./exec.js";
import type { RecoverAction } from "./reconcile.js";

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
  result?: RecoverResult | { ok: boolean; message: string; jobId?: string };
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
    case "retry_implement":
      return {
        step: "blocked_wait",
        action,
        reason: `blocked job holds the slot: ${action.reason}`,
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
 * Never auto-merges. Blocked jobs do not free the slot.
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

      const cycle = runOneCycle({
        configPath: options.configPath,
        dryRun: options.dryRun,
        pollSeconds,
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

function runOneCycle(opts: {
  configPath?: string;
  dryRun?: boolean;
  pollSeconds: number;
  log: (line: string) => void;
}): WatchCycleResult {
  const { log } = opts;

  // 1) Inspect (dry recover always for plan)
  const inspected = recover({
    configPath: opts.configPath,
    dryRun: true,
    waitMergeTimeoutMinutes: 0,
  });
  const plan = planWatchCycle(inspected.action);
  log(`plan: ${plan.step} — ${plan.reason}`);

  if (opts.dryRun) {
    return { plan, result: inspected, sleptSeconds: 0 };
  }

  // 2) Execute
  if (plan.step === "blocked_wait" || plan.step === "noop_sleep") {
    log(plan.reason);
    return { plan, result: inspected, sleptSeconds: 0 };
  }

  if (plan.step === "claim_and_implement") {
    log("no active job → run-once (claim if eligible)");
    const r = runOnce({ configPath: opts.configPath });
    log(`${r.ok ? "ok" : "fail"}: ${r.message}`);
    // If we just finished implement, chain audit in same cycle for throughput
    if (r.ok && r.details && (r.details as { state?: string }).state === "awaiting_audit") {
      log("chaining audit-once after implement");
      const a = recover({
        configPath: opts.configPath,
        dryRun: false,
        waitMergeTimeoutMinutes: 0,
      });
      log(`chain: ${a.action.kind} — ${a.message}`);
      return { plan, result: a, sleptSeconds: 0 };
    }
    // run-once may return "no eligible issue"
    return { plan, result: r, sleptSeconds: 0 };
  }

  if (plan.step === "resume") {
    log(`execute resume: ${plan.action.kind}`);
    const r = recover({
      configPath: opts.configPath,
      dryRun: false,
      waitMergeTimeoutMinutes: 0,
    });
    log(`${r.ok ? "ok" : "fail"}: ${r.message}`);

    // Optional chain: after audit_passed in same cycle → publish
    // recover already did one step; next cycle will publish. Keep one step
    // per cycle for simpler failure isolation, except implement→audit above.
    return { plan, result: r, sleptSeconds: 0 };
  }

  return { plan, sleptSeconds: 0 };
}

function sleepSeconds(seconds: number): void {
  execFile("sleep", [String(seconds)], {
    timeoutMs: (seconds + 2) * 1000,
  });
}
