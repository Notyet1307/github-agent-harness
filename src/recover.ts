import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  auditResultMatchesShas,
  loadAuditResult,
} from "./audit-gate.js";
import {
  defaultLedgerPath,
  defaultLockPath,
  loadConfig,
} from "./config.js";
import { commitCountSince, revParse } from "./git.js";
import { execFile } from "./exec.js";
import {
  findPrByHead,
  viewPullRequest,
} from "./github.js";
import { Ledger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import { orcaJson, requireOrcaCli, unwrapResult } from "./orca.js";
import { reconcileJob, type RecoverAction, type ReconcileHints } from "./reconcile.js";
import { runOnce } from "./run-once.js";
import { auditOnce } from "./audit-once.js";
import { publishOnce } from "./publisher.js";
import { waitMerge } from "./merge-monitor.js";
import type { Job } from "./types.js";

export type RecoverResult = {
  ok: boolean;
  message: string;
  action: RecoverAction;
  jobId?: string;
  details?: Record<string, unknown>;
  executed?: boolean;
};

/**
 * M5 entry: inspect active job + world, decide next ensure* step,
 * optionally execute it (not dry-run).
 */
export function recover(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  dryRun?: boolean;
  /** When executing wait_merge, only poll once by default. */
  waitMergeTimeoutMinutes?: number;
}): RecoverResult {
  const config = loadConfig(options.configPath);
  const lock = acquireLock(options.lockPath ?? defaultLockPath());
  if (!lock.ok) {
    return {
      ok: false,
      message: lock.error ?? "lock failed",
      action: { kind: "none", reason: "lock" },
    };
  }
  const ledger = new Ledger(options.ledgerPath ?? defaultLedgerPath());
  try {
    const job = ledger.getActiveJob();
    const hints = gatherHints(config, job);
    const action = reconcileJob(job, hints);

    const base: RecoverResult = {
      ok: true,
      message: action.reason,
      action,
      jobId: job?.id,
      details: {
        state: job?.state ?? null,
        repo: job ? `${job.repo}#${job.issue_number}` : null,
        hints,
      },
      executed: false,
    };

    if (options.dryRun || action.kind === "noop" || action.kind === "none") {
      return base;
    }
    if (action.kind === "blocked") {
      return { ...base, ok: false, message: action.reason };
    }
    if (job?.state === "blocked" && action.kind === "audit_once") {
      ledger.updateJob(job.id, {
        state: "auditing",
        last_error: null,
      });
    }

    // Execute without holding outer lock across long agent runs:
    // release before *Once which re-acquires.
    ledger.close();
    lock.release();

    return executeAction(action, {
      configPath: options.configPath,
      ledgerPath: options.ledgerPath,
      lockPath: options.lockPath,
      waitMergeTimeoutMinutes: options.waitMergeTimeoutMinutes ?? 0,
      jobId: job?.id,
      hints,
    });
  } finally {
    try {
      ledger.close();
    } catch {
      // may already be closed
    }
    lock.release();
  }
}

function executeAction(
  action: RecoverAction,
  opts: {
    configPath?: string;
    ledgerPath?: string;
    lockPath?: string;
    waitMergeTimeoutMinutes: number;
    jobId?: string;
    hints: ReconcileHints;
  },
): RecoverResult {
  switch (action.kind) {
    case "run_once": {
      const r = runOnce({
        configPath: opts.configPath,
        ledgerPath: opts.ledgerPath,
        lockPath: opts.lockPath,
      });
      return {
        ok: r.ok,
        message: `recover→run-once: ${r.message}`,
        action,
        jobId: r.jobId ?? opts.jobId,
        details: r.details,
        executed: true,
      };
    }
    case "audit_once": {
      const r = auditOnce({
        configPath: opts.configPath,
        ledgerPath: opts.ledgerPath,
        lockPath: opts.lockPath,
        withRework: true,
      });
      return {
        ok: r.ok,
        message: `recover→audit-once: ${r.message}`,
        action,
        jobId: r.jobId ?? opts.jobId,
        details: r.details,
        executed: true,
      };
    }
    case "publish_once": {
      const r = publishOnce({
        configPath: opts.configPath,
        ledgerPath: opts.ledgerPath,
        lockPath: opts.lockPath,
      });
      return {
        ok: r.ok,
        message: `recover→publish-once: ${r.message}`,
        action,
        jobId: r.jobId ?? opts.jobId,
        details: r.details,
        executed: true,
      };
    }
    case "wait_merge": {
      const r = waitMerge({
        configPath: opts.configPath,
        ledgerPath: opts.ledgerPath,
        lockPath: opts.lockPath,
        timeoutMinutes: opts.waitMergeTimeoutMinutes,
      });
      return {
        ok: r.ok,
        message: `recover→wait-merge: ${r.message}`,
        action,
        jobId: r.jobId ?? opts.jobId,
        details: r.details,
        executed: true,
      };
    }
    default:
      return {
        ok: true,
        message: action.reason,
        action,
        jobId: opts.jobId,
        executed: false,
      };
  }
}

function gatherHints(
  config: ReturnType<typeof loadConfig>,
  job: Job | null,
): ReconcileHints {
  const hints: ReconcileHints = {};
  if (!job) return hints;

  if (job.worktree_path) {
    hints.worktreeExists = existsSync(job.worktree_path);
    if (hints.worktreeExists && job.base_sha) {
      const head = revParse(job.worktree_path, "HEAD");
      hints.currentHeadSha = head;
      hints.hasCommitsSinceBase =
        Boolean(head) &&
        head !== job.base_sha &&
        commitCountSince(job.worktree_path, job.base_sha) >= 1;
      const tracked = execFile("git", [
        "-C",
        job.worktree_path,
        "status",
        "--porcelain",
        "-uno",
      ]);
      hints.trackedClean = tracked.ok && !tracked.stdout.trim();

      const resultPath = join(job.worktree_path, ".harness", "audit-result.json");
      if (head) {
        const loaded = loadAuditResult(resultPath);
        hints.auditResultReady = Boolean(
          loaded.ok &&
            loaded.result &&
            auditResultMatchesShas(loaded.result, job.base_sha, head),
        );
      }
    }
  }

  // Task status from Orca (best-effort)
  try {
    const orcaCli = requireOrcaCli(config);
    const listed = orcaJson(orcaCli, ["orchestration", "task-list"]);
    if (listed.ok && listed.data) {
      const result = unwrapResult<{
        tasks?: Array<{ id?: string; status?: string }>;
      }>(listed.data);
      const tasks = result.tasks ?? [];
      if (job.implementer_task_id) {
        const t = tasks.find((x) => x.id === job.implementer_task_id);
        hints.implementTaskStatus = t?.status ?? null;
      }
      if (job.auditor_task_id) {
        const t = tasks.find((x) => x.id === job.auditor_task_id);
        hints.auditTaskStatus = t?.status ?? null;
      }
    }
  } catch {
    // ignore
  }

  // PR world state
  if (job.repo && job.branch) {
    const repo = config.repositories.find((r) => r.github === job.repo);
    if (repo) {
      if (job.pr_url || job.pr_number) {
        const v = viewPullRequest(repo, job.pr_url ?? String(job.pr_number));
        if (v.ok && v.pr) {
          hints.prExists = true;
          hints.prMerged = Boolean(v.pr.mergedAt) || v.pr.state === "MERGED";
          hints.prClosedUnmerged =
            v.pr.state === "CLOSED" && !v.pr.mergedAt;
        }
      } else {
        const found = findPrByHead(repo, job.branch);
        hints.prExists = Boolean(found.pr);
        if (found.pr) {
          const v = viewPullRequest(repo, found.pr.number);
          if (v.ok && v.pr) {
            hints.prMerged = Boolean(v.pr.mergedAt) || v.pr.state === "MERGED";
            hints.prClosedUnmerged =
              v.pr.state === "CLOSED" && !v.pr.mergedAt;
          }
        }
      }
    }
  }

  return hints;
}
