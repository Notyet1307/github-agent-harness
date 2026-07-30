import { existsSync } from "node:fs";
import { defaultLedgerPath, defaultLockPath } from "./config.js";
import { currentBranch, revParse, statusPorcelain } from "./git.js";
import { Ledger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import { orcaJson, requireOrcaCli } from "./orca.js";
import { loadRuntimeConfig } from "./project.js";
import { TERMINAL_JOB_STATES, type Job } from "./types.js";

export type LifecycleItem = {
  jobId: string;
  repo: string;
  issueNumber: number;
  state: Job["state"];
  action: "cancel" | "reopen_audit" | "remove_worktree" | "clear_missing_worktree" | "noop";
  ok: boolean;
  message: string;
  branch?: string;
  headSha?: string;
  executed: boolean;
};

export type LifecycleResult = {
  ok: boolean;
  message: string;
  items: LifecycleItem[];
};

type LifecycleOptions = {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  jobId?: string;
  dryRun?: boolean;
};

export function cancelJob(
  options: LifecycleOptions & { reason?: string; removeWorktree?: boolean },
): LifecycleResult {
  const dryRun = options.dryRun !== false;
  if (!dryRun && !options.reason?.trim()) {
    return {
      ok: false,
      message: "cancel --execute requires a non-empty --reason",
      items: [],
    };
  }
  const lock = acquireLock(options.lockPath ?? defaultLockPath());
  if (!lock.ok) {
    return { ok: false, message: lock.error ?? "lock failed", items: [] };
  }
  const ledger = new Ledger(options.ledgerPath ?? defaultLedgerPath());
  try {
    const job = options.jobId
      ? ledger.getJob(options.jobId)
      : ledger.getActiveJob();
    if (!job) {
      return {
        ok: !options.jobId,
        message: options.jobId ? `job not found: ${options.jobId}` : "no active job",
        items: [],
      };
    }
    if (job.state === "cancelled") {
      return {
        ok: true,
        message: `job ${job.id} is already cancelled`,
        items: [item(job, "noop", true, "already cancelled", false)],
      };
    }
    if (job.state === "merged") {
      return {
        ok: false,
        message: `job ${job.id} is already merged; use cleanup instead`,
        items: [item(job, "noop", false, "merged jobs cannot be cancelled", false)],
      };
    }

    const reason = options.reason?.trim() || "<reason required for execute>";
    const cancelItem = item(
      job,
      "cancel",
      true,
      `mark cancelled: ${reason}`,
      !dryRun,
    );
    if (dryRun) {
      const items = [cancelItem];
      if (options.removeWorktree) items.push(inspectRemoval(job, false));
      return { ok: items.every((entry) => entry.ok), message: "cancel plan", items };
    }

    const cancelled = ledger.updateJobIf(job.id, job.revision, {
      state: "cancelled",
      last_error: `cancelled: ${reason}`,
      intervention_resolved_at: new Date().toISOString(),
    });
    if (!cancelled) {
      return {
        ok: false,
        message: `job ${job.id} changed before cancellation; re-run dry-run`,
        items: [{ ...cancelItem, ok: false, executed: false }],
      };
    }
    if (!options.removeWorktree) {
      return { ok: true, message: `cancelled job ${job.id}`, items: [cancelItem] };
    }
    const removal = removeTerminalWorktree(cancelled, ledger, options.configPath);
    return {
      ok: removal.ok,
      message: removal.ok
        ? `cancelled job ${job.id} and cleaned its worktree`
        : `cancelled job ${job.id}; worktree cleanup was refused or failed`,
      items: [cancelItem, removal],
    };
  } finally {
    ledger.close();
    lock.release();
  }
}

/**
 * Human-gated escape hatch for a final audit failure with newly understood,
 * actionable findings. Rework repeats the final audit round; it never raises
 * the configured retry ceiling or discards the evidence that caused the block.
 */
export function reopenAuditFailure(
  options: LifecycleOptions & { reason?: string },
): LifecycleResult {
  const dryRun = options.dryRun !== false;
  if (!dryRun && !options.reason?.trim()) {
    return { ok: false, message: "reopen --execute requires a non-empty --reason", items: [] };
  }
  const lock = acquireLock(options.lockPath ?? defaultLockPath());
  if (!lock.ok) return { ok: false, message: lock.error ?? "lock failed", items: [] };
  const ledger = new Ledger(options.ledgerPath ?? defaultLedgerPath());
  try {
    const job = options.jobId ? ledger.getJob(options.jobId) : ledger.getActiveJob();
    if (!job) return { ok: false, message: options.jobId ? `job not found: ${options.jobId}` : "no active job", items: [] };
    const audit = parseFailedAudit(job.audit_result_json);
    if (job.state !== "blocked" || !audit || !job.audit_head_sha || job.audit_round < 1) {
      return { ok: false, message: `job ${job.id} is not a blocked job with final failed audit evidence`, items: [item(job, "noop", false, "requires blocked failed audit evidence", false)] };
    }
    const reason = options.reason?.trim() || "<reason required for execute>";
    const plan = item(job, "reopen_audit", true, `repeat audit round ${job.audit_round} after rework: ${reason}`, !dryRun);
    if (dryRun) return { ok: true, message: "reopen audit plan", items: [plan] };
    const reopened = ledger.updateJobIf(job.id, job.revision, {
      state: "reworking",
      audit_round: job.audit_round - 1,
      implementer_task_id: null,
      implementer_dispatch_id: null,
      auditor_terminal_handle: null,
      auditor_task_id: null,
      auditor_dispatch_id: null,
      dispatch_attempt: 0,
      dispatch_probe_pending: 0,
      last_error: `reopened after failed audit r${job.audit_round}: ${reason}`,
      intervention_resolved_at: new Date().toISOString(),
    });
    if (!reopened) return { ok: false, message: `job ${job.id} changed before reopen; re-run dry-run`, items: [{ ...plan, ok: false, executed: false }] };
    return { ok: true, message: `reopened job ${job.id} for rework and repeated audit r${job.audit_round}`, items: [plan] };
  } finally {
    ledger.close();
    lock.release();
  }
}

function parseFailedAudit(value: string | null): boolean {
  try {
    return JSON.parse(value ?? "{}").status === "fail";
  } catch {
    return false;
  }
}

export function cleanupJobs(options: LifecycleOptions): LifecycleResult {
  const dryRun = options.dryRun !== false;
  const lock = acquireLock(options.lockPath ?? defaultLockPath());
  if (!lock.ok) {
    return { ok: false, message: lock.error ?? "lock failed", items: [] };
  }
  const ledger = new Ledger(options.ledgerPath ?? defaultLedgerPath());
  try {
    const jobs = options.jobId
      ? [ledger.getJob(options.jobId)].filter((job): job is Job => Boolean(job))
      : ledger.listJobs(10_000).filter((job) => TERMINAL_JOB_STATES.has(job.state));
    if (jobs.length === 0) {
      return {
        ok: !options.jobId,
        message: options.jobId ? `job not found: ${options.jobId}` : "no terminal jobs",
        items: [],
      };
    }
    const inspections = jobs.map((job) => {
      if (!TERMINAL_JOB_STATES.has(job.state)) {
        return item(
          job,
          "noop",
          false,
          "active jobs cannot be cleaned; cancel explicitly first",
          false,
        );
      }
      return inspectRemoval(job, false);
    });
    if (dryRun || inspections.some((entry) => !entry.ok)) {
      return {
        ok: inspections.every((entry) => entry.ok),
        message: dryRun ? "cleanup plan" : "cleanup refused; no worktrees removed",
        items: inspections,
      };
    }
    const items = jobs.map((job) =>
      removeTerminalWorktree(job, ledger, options.configPath),
    );
    return {
      ok: items.every((entry) => entry.ok),
      message: dryRun ? "cleanup plan" : "cleanup complete",
      items,
    };
  } finally {
    ledger.close();
    lock.release();
  }
}

function inspectRemoval(job: Job, executed: boolean): LifecycleItem {
  if (!job.worktree_id && !job.worktree_path) {
    return item(job, "noop", true, "no recorded worktree", executed);
  }
  if (!job.worktree_id || !job.worktree_path) {
    return item(
      job,
      "noop",
      false,
      "incomplete worktree identity; refusing cleanup",
      executed,
    );
  }
  if (!existsSync(job.worktree_path)) {
    return item(
      job,
      "clear_missing_worktree",
      true,
      "worktree path is already absent; clear stale ledger handles",
      executed,
    );
  }
  const dirty = statusPorcelain(job.worktree_path);
  if (dirty) {
    return item(
      job,
      "noop",
      false,
      `worktree is dirty; refusing cleanup:\n${dirty}`,
      executed,
    );
  }
  const branch = currentBranch(job.worktree_path);
  const headSha = revParse(job.worktree_path, "HEAD");
  if (!branch || !headSha) {
    return item(
      job,
      "noop",
      false,
      "cannot prove worktree branch and HEAD; refusing cleanup",
      executed,
    );
  }
  if (job.branch && branch !== job.branch) {
    return item(
      job,
      "noop",
      false,
      `worktree branch changed: expected ${job.branch}, got ${branch}`,
      executed,
    );
  }
  return {
    ...item(
      job,
      "remove_worktree",
      true,
      `remove clean Orca worktree; preserve branch ${branch} at ${headSha}`,
      executed,
    ),
    branch,
    headSha,
  };
}

function removeTerminalWorktree(
  job: Job,
  ledger: Ledger,
  configPath?: string,
): LifecycleItem {
  const inspection = inspectRemoval(job, false);
  if (!inspection.ok || inspection.action === "noop") return inspection;
  if (inspection.action === "clear_missing_worktree") {
    const cleared = clearWorktreeHandles(ledger, job);
    return cleared
      ? { ...inspection, executed: true }
      : {
          ...inspection,
          ok: false,
          message: "job changed before stale worktree handles were cleared",
        };
  }
  let removed;
  try {
    const config = loadRuntimeConfig(configPath);
    const orcaCli = requireOrcaCli(config);
    removed = orcaJson(
      orcaCli,
      ["worktree", "rm", "--worktree", `id:${job.worktree_id}`, "--force"],
      { timeoutMs: 120_000 },
    );
  } catch (err) {
    return {
      ...inspection,
      ok: false,
      message: `cannot invoke Orca cleanup: ${(err as Error).message}`,
    };
  }
  if (!removed.ok) {
    return {
      ...inspection,
      ok: false,
      message: `Orca worktree removal failed: ${removed.error ?? "unknown error"}`,
    };
  }
  const cleared = clearWorktreeHandles(ledger, job);
  return cleared
    ? { ...inspection, executed: true }
    : {
        ...inspection,
        ok: false,
        executed: true,
        message: "worktree removed but job changed before ledger handles were cleared",
      };
}

function clearWorktreeHandles(ledger: Ledger, job: Job): Job | null {
  return ledger.updateJobIf(job.id, job.revision, {
    worktree_id: null,
    worktree_path: null,
    implementer_terminal_handle: null,
    auditor_terminal_handle: null,
  });
}

function item(
  job: Job,
  action: LifecycleItem["action"],
  ok: boolean,
  message: string,
  executed: boolean,
): LifecycleItem {
  return {
    jobId: job.id,
    repo: job.repo,
    issueNumber: job.issue_number,
    state: job.state,
    action,
    ok,
    message,
    executed,
  };
}
