import { defaultLedgerPath, defaultLockPath } from "./config.js";
import { execFile } from "./exec.js";
import {
  branchHasRequiredStatusChecks,
  disablePullRequestAutoMerge,
  enablePullRequestAutoMerge,
  viewPullRequest,
  type PullRequestView,
} from "./github.js";
import { Ledger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import { orcaStatus, requireOrcaCli } from "./orca.js";
import { loadRuntimeConfig, validateProjectRuntime } from "./project.js";
import { setWorktreeProgress } from "./orca-runtime.js";
import type { Job, RepoConfig, RuntimeHarnessConfig } from "./types.js";

export type WaitMergeResult = {
  ok: boolean;
  jobId?: string;
  message: string;
  details?: Record<string, unknown>;
};

type MergePollResult =
  | { done: true; result: WaitMergeResult }
  | { done: false; job: Job };

/**
 * Poll GitHub until merged, closed-unmerged, or timeout.
 * Auto mode asks GitHub to merge only the audited PR head; GitHub's branch
 * rules remain the authority for CI/review requirements.
 */
export function waitMerge(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  /** Max wait; 0 = single poll. Default 60 minutes. */
  timeoutMinutes?: number;
  pollSeconds?: number;
}): WaitMergeResult {
  const config = loadRuntimeConfig(options.configPath);
  const ledgerPath = options.ledgerPath ?? defaultLedgerPath();
  const lockPath = options.lockPath ?? defaultLockPath();
  const timeoutMinutes = options.timeoutMinutes ?? 60;
  const pollSeconds = options.pollSeconds ?? 30;
  const deadline =
    timeoutMinutes <= 0
      ? Date.now()
      : Date.now() + timeoutMinutes * 60_000;
  let expectedJobId: string | undefined;

  // Always poll at least once. The PID lock is held for one observation and
  // its CAS commit, never for the sleep between observations.
  for (;;) {
    const lock = acquireLock(lockPath);
    if (!lock.ok) return { ok: false, message: lock.error ?? "lock failed" };
    const ledger = new Ledger(ledgerPath);
    let polled: MergePollResult;
    try {
      polled = pollMergeOnce(config, ledger, expectedJobId);
    } finally {
      ledger.close();
      lock.release();
    }

    if (polled.done) return polled.result;
    expectedJobId = polled.job.id;

    if (Date.now() >= deadline) {
      return {
        ok: true,
        jobId: polled.job.id,
        message:
          timeoutMinutes <= 0
            ? "single poll complete; still awaiting_merge"
            : `timeout after ${timeoutMinutes}m; still awaiting_merge`,
        details: {
          state: polled.job.state,
          pr_url: polled.job.pr_url,
          last_error: polled.job.last_error,
        },
      };
    }

    const sleepSec = Math.max(
      1,
      Math.min(pollSeconds, Math.ceil((deadline - Date.now()) / 1000)),
    );
    execFile("sleep", [String(sleepSec)], {
      timeoutMs: (sleepSec + 2) * 1000,
    });
  }
}

function pollMergeOnce(
  config: RuntimeHarnessConfig,
  ledger: Ledger,
  expectedJobId?: string,
): MergePollResult {
  const log = (message: string) =>
    process.stdout.write(`[wait-merge] ${message}\n`);
  let job = ledger.getActiveJob();
  if (!job) {
    // Friendly path: user re-runs wait-merge after merge was already recorded.
    const recent = ledger.listJobs(1)[0];
    if (
      recent?.state === "merged" &&
      (!expectedJobId || recent.id === expectedJobId)
    ) {
      return {
        done: true,
        result: {
          ok: true,
          jobId: recent.id,
          message: "no active job; latest job already merged (nothing to do)",
          details: {
            pr_url: recent.pr_url,
            merged_at: recent.merged_at,
            issue: `${recent.repo}#${recent.issue_number}`,
          },
        },
      };
    }
    return {
      done: true,
      result: {
        ok: false,
        message:
          "no active job (nothing in awaiting_merge). Check: pnpm harness status",
      },
    };
  }

  if (expectedJobId && job.id !== expectedJobId) {
    return jobChanged(expectedJobId);
  }
  const project = ledger.resolveJobProject(job.id, config.repositories);
  if (!project.ok) {
    const blocked = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: project.error,
    });
    return {
      done: true,
      result: { ok: false, jobId: blocked.id, message: project.error },
    };
  }
  job = project.job;
  const repo = project.project;
  if (job.state !== "awaiting_merge") {
    return {
      done: true,
      result: {
        ok: false,
        jobId: job.id,
        message: `job state ${job.state} is not awaiting_merge`,
      },
    };
  }
  if (!job.pr_url && !job.pr_number) {
    return {
      done: true,
      result: {
        ok: false,
        jobId: job.id,
        message: "no pr_url/pr_number on job",
      },
    };
  }

  const orcaCli = requireOrcaCli(config);
  const status = orcaStatus(orcaCli);
  if (!status.ok) {
    return {
      done: true,
      result: {
        ok: false,
        message: `orca not ready: ${status.error ?? "unknown"}`,
      },
    };
  }
  const runtime = validateProjectRuntime(repo, orcaCli);
  if (!runtime.ok) {
    const blocked = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: runtime.error,
    });
    return {
      done: true,
      result: { ok: false, jobId: blocked.id, message: runtime.error },
    };
  }

  const selector = job.pr_url ?? String(job.pr_number);
  const viewed = viewPullRequest(repo, selector);
  if (!viewed.ok || !viewed.pr) {
    log(`pr view failed: ${viewed.error ?? "unknown"}`);
    return { done: false, job };
  }

  const decision = classifyPr(viewed.pr);
  log(
    `PR #${viewed.pr.number} state=${viewed.pr.state} mergedAt=${viewed.pr.mergedAt ?? "null"} review=${viewed.pr.reviewDecision ?? "-"} checks=${summarizeChecks(viewed.pr)}`,
  );

  if (decision.kind === "merged") {
    return {
      done: true,
      result: markMerged(ledger, orcaCli, job, viewed.pr, log),
    };
  }
  if (decision.kind === "closed_unmerged") {
    const updated = ledger.updateJobIf(job.id, job.revision, {
      state: "blocked",
      last_error: `PR #${viewed.pr.number} closed without merge`,
      pr_number: viewed.pr.number,
      pr_url: viewed.pr.url,
    });
    if (!updated) return jobChanged(job.id);
    setWorktreeProgress(
      orcaCli,
      updated.worktree_id!,
      "harness: blocked — PR closed unmerged",
      "in-progress",
    );
    return {
      done: true,
      result: {
        ok: false,
        jobId: updated.id,
        message: updated.last_error!,
        details: viewed.pr,
      },
    };
  }

  if (config.mergePolicy.mode === "auto") {
    if (viewed.pr.baseRefName !== repo.defaultBranch) {
      return blockAutoMerge(
        ledger,
        orcaCli,
        repo,
        job,
        viewed.pr,
        `PR base ${viewed.pr.baseRefName ?? "unknown"} differs from configured default branch ${repo.defaultBranch}`,
        log,
      );
    }
    const branchRules = branchHasRequiredStatusChecks(repo);
    if (!branchRules.ok) {
      return blockAutoMerge(
        ledger,
        orcaCli,
        repo,
        job,
        viewed.pr,
        `cannot verify required status checks: ${branchRules.error ?? "unknown"}`,
        log,
      );
    }
    if (!branchRules.configured) {
      return blockAutoMerge(
        ledger,
        orcaCli,
        repo,
        job,
        viewed.pr,
        `auto merge requires branch-required status checks on ${repo.defaultBranch}`,
        log,
      );
    }
    if (!job.head_sha || !viewed.pr.headRefOid) {
      return blockAutoMerge(
        ledger,
        orcaCli,
        repo,
        job,
        viewed.pr,
        "cannot verify PR head against audited head",
        log,
      );
    }
    if (job.head_sha !== viewed.pr.headRefOid) {
      return blockAutoMerge(
        ledger,
        orcaCli,
        repo,
        job,
        viewed.pr,
        `PR head ${viewed.pr.headRefOid} differs from audited head ${job.head_sha}`,
        log,
      );
    }
  }

  if (decision.kind === "needs_work") {
    if (config.mergePolicy.mode === "auto") {
      const cancellation = cancelAutoMergeIfRequested(
        ledger,
        job,
        repo,
        viewed.pr,
        log,
      );
      if (cancellation) return cancellation;
    }
    const updated = ledger.updateJobIf(job.id, job.revision, {
      last_error: decision.reason,
      pr_number: viewed.pr.number,
      pr_url: viewed.pr.url,
    });
    if (!updated) return jobChanged(job.id);
    job = updated;
    // Keep awaiting_merge; do not auto-rework in V1 wait loop
    // (human may fix CI or request rework explicitly later).
    setWorktreeProgress(
      orcaCli,
      job.worktree_id!,
      `harness: PR needs work — ${decision.reason}`.slice(0, 180),
      "in-review",
    );
    return { done: false, job };
  }

  if (config.mergePolicy.mode === "auto") {
    // Ask GitHub as soon as the audited PR is safe to queue.  GitHub keeps
    // the merge pending until its required checks and reviews are satisfied;
    // waiting for CLEAN here created an unnecessary extra watch cycle.
    if (!viewed.pr.autoMergeRequest) {
      const expectedHeadSha = job.head_sha;
      if (!expectedHeadSha) {
        return blockAutoMerge(
          ledger,
          orcaCli,
          repo,
          job,
          viewed.pr,
          "cannot verify PR head against audited head",
          log,
        );
      }
      const requested = enablePullRequestAutoMerge(
        repo,
        viewed.pr.number,
        expectedHeadSha,
      );
      if (!requested.ok) {
        const error = `GitHub auto-merge request failed: ${requested.error ?? "unknown"}`;
        const updated = ledger.updateJobIf(job.id, job.revision, {
          pr_number: viewed.pr.number,
          pr_url: viewed.pr.url,
          last_error: error,
        });
        if (!updated) return jobChanged(job.id);
        log(error);
        return { done: false, job: updated };
      }
      log(`requested GitHub auto-merge for PR #${viewed.pr.number}`);
    }

    if (viewed.pr.mergeStateStatus !== "CLEAN") {
      log(
        `GitHub auto-merge queued; waiting for branch protections (merge state ${viewed.pr.mergeStateStatus ?? "unknown"})`,
      );
      const updated = ledger.updateJobIf(job.id, job.revision, {
        pr_number: viewed.pr.number,
        pr_url: viewed.pr.url,
        last_error: null,
      });
      if (!updated) return jobChanged(job.id);
      return { done: false, job: updated };
    }
  }

  const updated = ledger.updateJobIf(job.id, job.revision, {
    pr_number: viewed.pr.number,
    pr_url: viewed.pr.url,
    last_error: null,
  });
  if (!updated) return jobChanged(job.id);
  job = updated;

  return { done: false, job };
}

function cancelAutoMergeIfRequested(
  ledger: Ledger,
  job: Job,
  repo: RepoConfig,
  pr: PullRequestView,
  log: (message: string) => void,
): MergePollResult | null {
  if (!pr.autoMergeRequest) return null;
  const disabled = disablePullRequestAutoMerge(repo, pr.number);
  if (disabled.ok) {
    log(`disabled GitHub auto-merge for PR #${pr.number}`);
    return null;
  }

  const error = `GitHub auto-merge disable failed: ${disabled.error ?? "unknown"}`;
  const updated = ledger.updateJobIf(job.id, job.revision, {
    pr_number: pr.number,
    pr_url: pr.url,
    last_error: error,
  });
  if (!updated) return jobChanged(job.id);
  log(error);
  return {
    done: true,
    result: { ok: false, jobId: updated.id, message: error, details: pr },
  };
}

function blockAutoMerge(
  ledger: Ledger,
  orcaCli: string,
  repo: RepoConfig,
  job: Job,
  pr: PullRequestView,
  error: string,
  log: (message: string) => void,
): MergePollResult {
  const cancellation = cancelAutoMergeIfRequested(ledger, job, repo, pr, log);
  if (cancellation) return cancellation;
  const updated = ledger.updateJobIf(job.id, job.revision, {
    state: "blocked",
    last_error: error,
    pr_number: pr.number,
    pr_url: pr.url,
  });
  if (!updated) return jobChanged(job.id);
  if (updated.worktree_id) {
    setWorktreeProgress(
      orcaCli,
      updated.worktree_id,
      `harness: blocked — ${error}`.slice(0, 180),
      "in-progress",
    );
  }
  return {
    done: true,
    result: {
      ok: false,
      jobId: updated.id,
      message: error,
      details: pr,
    },
  };
}

function jobChanged(jobId: string): MergePollResult {
  return {
    done: true,
    result: {
      ok: false,
      jobId,
      message: "job changed during merge poll; retry coordination cycle",
    },
  };
}

function markMerged(
  ledger: Ledger,
  orcaCli: string,
  job: Job,
  pr: PullRequestView,
  log: (message: string) => void,
): WaitMergeResult {
  const mergedAt = pr.mergedAt ?? new Date().toISOString();
  const updated = ledger.updateJobIf(job.id, job.revision, {
    state: "merged",
    merged_at: mergedAt,
    pr_number: pr.number,
    pr_url: pr.url,
    last_error: null,
  });
  if (!updated) {
    return {
      ok: false,
      jobId: job.id,
      message: "job changed during merge poll; retry coordination cycle",
    };
  }

  if (updated.worktree_id) {
    setWorktreeProgress(
      orcaCli,
      updated.worktree_id,
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
    (check) =>
      (check.conclusion &&
        ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(
          check.conclusion.toUpperCase(),
        )) ||
      (check.state && check.state.toUpperCase() === "FAILURE"),
  );
  if (failed.length > 0) {
    const names = failed
      .map((check) => check.name ?? check.context ?? "?")
      .join(", ");
    return { kind: "needs_work", reason: `CI failed: ${names}` };
  }

  return { kind: "waiting" };
}

function summarizeChecks(pr: PullRequestView): string {
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) return "none";
  const parts = checks.map((check) => {
    const name = check.name ?? check.context ?? "?";
    const state = check.conclusion ?? check.state ?? "?";
    return `${name}:${state}`;
  });
  return parts.slice(0, 6).join(",") + (parts.length > 6 ? "…" : "");
}
