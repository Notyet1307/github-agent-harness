import {
  defaultLedgerPath,
  defaultLockPath,
  loadConfig,
} from "./config.js";
import { execFile } from "./exec.js";
import { viewPullRequest, type PullRequestView } from "./github.js";
import { Ledger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import { orcaStatus, requireOrcaCli } from "./orca.js";
import { setWorktreeProgress } from "./orca-runtime.js";
import type { HarnessConfig, Job } from "./types.js";

export type WaitMergeResult = {
  ok: boolean;
  jobId?: string;
  message: string;
  details?: Record<string, unknown>;
};

/**
 * Poll GitHub until merged, closed-unmerged, or timeout.
 * Does not auto-merge. On CI failure / changes requested, records last_error
 * and keeps awaiting_merge (human or later rework command).
 */
export function waitMerge(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  /** Max wait; 0 = single poll. Default 60 minutes. */
  timeoutMinutes?: number;
  pollSeconds?: number;
}): WaitMergeResult {
  const config = loadConfig(options.configPath);
  const lock = acquireLock(options.lockPath ?? defaultLockPath());
  if (!lock.ok) return { ok: false, message: lock.error ?? "lock failed" };
  const ledger = new Ledger(options.ledgerPath ?? defaultLedgerPath());
  try {
    return waitMergeLocked(config, ledger, {
      timeoutMinutes: options.timeoutMinutes ?? 60,
      pollSeconds: options.pollSeconds ?? 30,
    });
  } finally {
    ledger.close();
    lock.release();
  }
}

function waitMergeLocked(
  config: HarnessConfig,
  ledger: Ledger,
  options: { timeoutMinutes: number; pollSeconds: number },
): WaitMergeResult {
  const log = (m: string) => process.stdout.write(`[wait-merge] ${m}\n`);

  let job = ledger.getActiveJob();
  if (!job) {
    // Friendly path: user re-runs wait-merge after merge was already recorded.
    const recent = ledger.listJobs(1)[0];
    if (recent?.state === "merged") {
      return {
        ok: true,
        jobId: recent.id,
        message: "no active job; latest job already merged (nothing to do)",
        details: {
          pr_url: recent.pr_url,
          merged_at: recent.merged_at,
          issue: `${recent.repo}#${recent.issue_number}`,
        },
      };
    }
    return {
      ok: false,
      message:
        "no active job (nothing in awaiting_merge). Check: pnpm harness status",
    };
  }

  if (job.state === "merged") {
    return {
      ok: true,
      jobId: job.id,
      message: "already merged",
      details: { pr_url: job.pr_url, merged_at: job.merged_at },
    };
  }

  if (job.state !== "awaiting_merge") {
    return {
      ok: false,
      jobId: job.id,
      message: `job state ${job.state} is not awaiting_merge`,
    };
  }
  if (!job.pr_url && !job.pr_number) {
    return {
      ok: false,
      jobId: job.id,
      message: "no pr_url/pr_number on job",
    };
  }

  const repo = config.repositories.find((r) => r.github === job!.repo);
  if (!repo) {
    return { ok: false, jobId: job.id, message: `repo not in config: ${job.repo}` };
  }

  const orcaCli = requireOrcaCli(config);
  const st = orcaStatus(orcaCli);
  if (!st.ok) {
    return { ok: false, message: `orca not ready: ${st.error ?? "unknown"}` };
  }

  const selector = job.pr_url ?? String(job.pr_number);
  const deadline =
    options.timeoutMinutes <= 0
      ? Date.now()
      : Date.now() + options.timeoutMinutes * 60_000;

  // always poll at least once
  for (;;) {
    const viewed = viewPullRequest(repo, selector);
    if (!viewed.ok || !viewed.pr) {
      log(`pr view failed: ${viewed.error ?? "unknown"}`);
    } else {
      const decision = classifyPr(viewed.pr);
      log(
        `PR #${viewed.pr.number} state=${viewed.pr.state} mergedAt=${viewed.pr.mergedAt ?? "null"} review=${viewed.pr.reviewDecision ?? "-"} checks=${summarizeChecks(viewed.pr)}`,
      );

      if (decision.kind === "merged") {
        return markMerged(config, ledger, orcaCli, job, viewed.pr, log);
      }
      if (decision.kind === "closed_unmerged") {
        job = ledger.updateJob(job.id, {
          state: "blocked",
          last_error: `PR #${viewed.pr.number} closed without merge`,
          pr_number: viewed.pr.number,
          pr_url: viewed.pr.url,
        });
        setWorktreeProgress(
          orcaCli,
          job.worktree_id!,
          `harness: blocked — PR closed unmerged`,
          "in-progress",
        );
        return {
          ok: false,
          jobId: job.id,
          message: job.last_error!,
          details: viewed.pr,
        };
      }
      if (decision.kind === "needs_work") {
        job = ledger.updateJob(job.id, {
          last_error: decision.reason,
          pr_number: viewed.pr.number,
          pr_url: viewed.pr.url,
        });
        // Keep awaiting_merge; do not auto-rework in V1 wait loop
        // (human may fix CI or request rework explicitly later).
        setWorktreeProgress(
          orcaCli,
          job.worktree_id!,
          `harness: PR needs work — ${decision.reason}`.slice(0, 180),
          "in-review",
        );
      } else {
        // still open / waiting
        job = ledger.updateJob(job.id, {
          pr_number: viewed.pr.number,
          pr_url: viewed.pr.url,
          last_error: null,
        });
      }
    }

    if (Date.now() >= deadline) {
      return {
        ok: true,
        jobId: job.id,
        message:
          options.timeoutMinutes <= 0
            ? "single poll complete; still awaiting_merge"
            : `timeout after ${options.timeoutMinutes}m; still awaiting_merge`,
        details: {
          state: job.state,
          pr_url: job.pr_url,
          last_error: job.last_error,
        },
      };
    }

    const sleepSec = Math.max(
      1,
      Math.min(options.pollSeconds, Math.ceil((deadline - Date.now()) / 1000)),
    );
    execFile("sleep", [String(sleepSec)], {
      timeoutMs: (sleepSec + 2) * 1000,
    });
  }
}

function markMerged(
  _config: HarnessConfig,
  ledger: Ledger,
  orcaCli: string,
  job: Job,
  pr: PullRequestView,
  log: (m: string) => void,
): WaitMergeResult {
  const mergedAt = pr.mergedAt ?? new Date().toISOString();
  const updated = ledger.updateJob(job.id, {
    state: "merged",
    merged_at: mergedAt,
    pr_number: pr.number,
    pr_url: pr.url,
    last_error: null,
  });

  if (job.worktree_id) {
    setWorktreeProgress(
      orcaCli,
      job.worktree_id,
      `harness: merged PR #${pr.number} at ${mergedAt}`,
      "completed",
    );
  }
  log(`merged PR #${pr.number}; slot free for next claim`);

  return {
    ok: true,
    jobId: updated.id,
    message: "PR merged; job complete (worktree retained for inspection)",
    details: {
      pr_number: pr.number,
      pr_url: pr.url,
      merged_at: mergedAt,
      note: "worktree not deleted in V1; marked completed in Orca",
    },
  };
}

function classifyPr(
  pr: PullRequestView,
):
  | { kind: "merged" }
  | { kind: "closed_unmerged" }
  | { kind: "needs_work"; reason: string }
  | { kind: "waiting" } {
  if (pr.mergedAt) return { kind: "merged" };
  if (pr.state === "MERGED") return { kind: "merged" };
  if (pr.state === "CLOSED") return { kind: "closed_unmerged" };

  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { kind: "needs_work", reason: "reviewDecision=CHANGES_REQUESTED" };
  }

  const checks = pr.statusCheckRollup ?? [];
  const failed = checks.filter(
    (c) =>
      (c.conclusion &&
        ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(
          c.conclusion.toUpperCase(),
        )) ||
      (c.state && c.state.toUpperCase() === "FAILURE"),
  );
  if (failed.length > 0) {
    const names = failed.map((c) => c.name ?? c.context ?? "?").join(", ");
    return { kind: "needs_work", reason: `CI failed: ${names}` };
  }

  return { kind: "waiting" };
}

function summarizeChecks(pr: PullRequestView): string {
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) return "none";
  const parts = checks.map((c) => {
    const name = c.name ?? c.context ?? "?";
    const st = c.conclusion ?? c.state ?? "?";
    return `${name}:${st}`;
  });
  return parts.slice(0, 6).join(",") + (parts.length > 6 ? "…" : "");
}
