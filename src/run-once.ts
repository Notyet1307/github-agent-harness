import { randomUUID } from "node:crypto";
import {
  defaultLedgerPath,
  defaultLockPath,
  getImplementerProfile,
  loadConfig,
} from "./config.js";
import {
  commitCountSince,
  currentBranch,
  ensureBranch,
  isPushed,
  logOnelineSince,
  revParse,
  statusPorcelain,
} from "./git.js";
import { Ledger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import { pickForRepo } from "./picker.js";
import { renderImplementerSpec } from "./prompts.js";
import { requireOrcaCli, orcaStatus } from "./orca.js";
import {
  createOrchestrationTask,
  dispatchTask,
  ensureControllerTerminal,
  ensureIssueWorktree,
  setWorktreeProgress,
  waitTerminalIdle,
  waitWorkerDone,
} from "./orca-runtime.js";
import type { HarnessConfig, Job, RepoConfig } from "./types.js";

export type RunOnceResult = {
  ok: boolean;
  jobId?: string;
  message: string;
  details?: Record<string, unknown>;
};

export function runOnce(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  repoFilter?: string;
  /** If set, resume/force this issue number instead of picking. */
  issueNumber?: number;
}): RunOnceResult {
  const config = loadConfig(options.configPath);
  const lock = acquireLock(options.lockPath ?? defaultLockPath());
  if (!lock.ok) {
    return { ok: false, message: lock.error ?? "lock failed" };
  }

  const ledger = new Ledger(options.ledgerPath ?? defaultLedgerPath());
  try {
    return runOnceLocked(config, ledger, options);
  } finally {
    ledger.close();
    lock.release();
  }
}

function runOnceLocked(
  config: HarnessConfig,
  ledger: Ledger,
  options: { repoFilter?: string; issueNumber?: number },
): RunOnceResult {
  const log = (msg: string) => {
    process.stdout.write(`[run-once] ${msg}\n`);
  };

  const orcaCli = requireOrcaCli(config);
  const status = orcaStatus(orcaCli);
  if (!status.ok) {
    return {
      ok: false,
      message: `orca runtime not ready: ${status.error ?? "unknown"}`,
    };
  }

  const implementer = getImplementerProfile(config);
  if (implementer.role !== "implementer") {
    return {
      ok: false,
      message: `active implementer profile has role=${implementer.role}`,
    };
  }

  // 1) Resume active job or claim new
  let job = ledger.getActiveJob();
  let repo: RepoConfig | undefined;

  if (job) {
    log(`resuming active job ${job.id} state=${job.state} ${job.repo}#${job.issue_number}`);
    repo = config.repositories.find((r) => r.github === job!.repo);
    if (!repo) {
      return {
        ok: false,
        jobId: job.id,
        message: `active job repo not in config: ${job.repo}`,
      };
    }
    if (
      job.state === "awaiting_audit" ||
      job.state === "auditing" ||
      job.state === "reworking"
    ) {
      return {
        ok: true,
        jobId: job.id,
        message: `job past implement (state=${job.state}); use harness audit-once`,
        details: { state: job.state, head_sha: job.head_sha },
      };
    }
    if (
      job.state === "audit_passed" ||
      job.state === "publishing" ||
      job.state === "awaiting_merge"
    ) {
      return {
        ok: true,
        jobId: job.id,
        message: `job past audit (state=${job.state}); use harness publish-once / wait-merge`,
        details: { state: job.state, head_sha: job.head_sha, pr_url: job.pr_url },
      };
    }
    if (job.state === "blocked") {
      // Allow automatic retry of blocked jobs that never got a worktree /
      // never dispatched (transient Orca failures). Hard blocks after
      // implement still need human cancel.
      const retryable =
        !job.implementer_task_id &&
        (job.last_error ?? "").toLowerCase().includes("orca");
      if (!retryable) {
        return {
          ok: false,
          jobId: job.id,
          message: `job is blocked: ${job.last_error ?? "no detail"}`,
        };
      }
      log(`retrying blocked job after Orca error: ${job.last_error}`);
      job = ledger.updateJob(job.id, {
        state: "claimed",
        last_error: null,
      });
    }
  } else {
    const repos = options.repoFilter
      ? config.repositories.filter((r) => r.github === options.repoFilter)
      : config.repositories;
    if (repos.length === 0) {
      return { ok: false, message: "no repositories to pick from" };
    }

    let claimed: Job | null = null;
    for (const r of repos) {
      const pick = pickForRepo(config, r, {
        ledgerIssueNumbers: ledger.ledgerIssueNumbers(r.github),
        hasActiveJob: false,
      });
      if (!pick.selected) continue;
      if (
        options.issueNumber != null &&
        pick.selected.number !== options.issueNumber
      ) {
        continue;
      }

      const id = randomUUID();
      const result = ledger.tryClaim({
        id,
        repo: r.github,
        issue: pick.selected,
        baseRef: r.baseRef,
        implementerProfileId: implementer.id,
      });
      if (!result.ok) {
        return { ok: false, message: `claim failed: ${result.error}` };
      }
      claimed = result.job;
      repo = r;
      log(
        `claimed ${r.github}#${pick.selected.number} ${pick.selected.title} as ${id}`,
      );
      break;
    }

    if (!claimed || !repo) {
      return { ok: false, message: "no eligible issue to claim" };
    }
    job = claimed;
  }

  if (!repo) {
    return { ok: false, message: "internal: repo missing" };
  }

  // 2) Controller terminal
  const controller = ensureControllerTerminal(orcaCli, config);
  if (!controller.ok) {
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: controller.error,
    });
    return {
      ok: false,
      jobId: job.id,
      message: `controller terminal: ${controller.error}`,
    };
  }
  job = ledger.updateJob(job.id, {
    controller_terminal_handle: controller.handle,
  });
  log(`controller terminal: ${controller.handle}`);

  // 3) Worktree
  if (!job.worktree_id || !job.worktree_path) {
    log(`creating worktree for #${job.issue_number} via profile ${implementer.id}`);
    const wt = ensureIssueWorktree(
      orcaCli,
      repo,
      job.issue_number,
      implementer,
    );
    if (!wt.ok) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: wt.error,
      });
      return { ok: false, jobId: job.id, message: wt.error };
    }

    const baseSha = revParse(wt.value.worktreePath, "HEAD");
    if (!baseSha) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: "failed to read base SHA",
        worktree_id: wt.value.worktreeId,
        worktree_path: wt.value.worktreePath,
      });
      return { ok: false, jobId: job.id, message: "failed to read base SHA" };
    }

    const desiredBranch = `agent/issue-${job.issue_number}`;
    const branchResult = ensureBranch(wt.value.worktreePath, desiredBranch);
    if (!branchResult.ok) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: branchResult.error ?? "branch ensure failed",
        worktree_id: wt.value.worktreeId,
        worktree_path: wt.value.worktreePath,
        base_sha: baseSha,
      });
      return {
        ok: false,
        jobId: job.id,
        message: branchResult.error ?? "branch ensure failed",
      };
    }

    job = ledger.updateJob(job.id, {
      state: "worktree_ready",
      worktree_id: wt.value.worktreeId,
      worktree_path: wt.value.worktreePath,
      base_sha: baseSha,
      branch: branchResult.branch,
      implementer_terminal_handle: wt.value.agentTerminalHandle,
      implementer_profile_id: implementer.id,
    });
    setWorktreeProgress(
      orcaCli,
      wt.value.worktreeId,
      `harness: worktree ready base=${baseSha.slice(0, 7)}`,
      "in-progress",
    );
    log(
      `worktree ${wt.value.worktreeId} path=${wt.value.worktreePath} base=${baseSha} branch=${branchResult.branch}`,
    );
  } else {
    log(`reusing worktree ${job.worktree_path}`);
  }

  // Refresh implementer terminal handle if missing
  if (!job.implementer_terminal_handle && job.worktree_id) {
    const refreshed = ensureIssueWorktree(
      orcaCli,
      repo,
      job.issue_number,
      implementer,
    );
    if (refreshed.ok && refreshed.value.agentTerminalHandle) {
      job = ledger.updateJob(job.id, {
        implementer_terminal_handle: refreshed.value.agentTerminalHandle,
      });
    }
  }

  if (!job.implementer_terminal_handle) {
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: "no implementer terminal handle",
    });
    return {
      ok: false,
      jobId: job.id,
      message: "no implementer terminal handle (is codex/pi installed in Orca?)",
    };
  }

  // 4) Wait TUI idle before dispatch (only if not already implementing with task)
  if (!job.implementer_task_id) {
    log(`waiting implementer TUI idle: ${job.implementer_terminal_handle}`);
    const idle = waitTerminalIdle(
      orcaCli,
      job.implementer_terminal_handle,
      90_000,
    );
    if (!idle.ok) {
      log(`warn: tui-idle wait: ${idle.error} (continuing to dispatch)`);
    }
  }

  // 5) Create + dispatch implement task
  if (!job.implementer_task_id) {
    if (!job.base_sha || !job.branch || !job.worktree_path) {
      return {
        ok: false,
        jobId: job.id,
        message: "missing base_sha/branch/worktree_path before dispatch",
      };
    }

    const spec = renderImplementerSpec({
      repo: repo.github,
      issueNumber: job.issue_number,
      issueUrl: job.issue_url,
      baseSha: job.base_sha,
      branch: job.branch,
      worktreePath: job.worktree_path,
      profileId: implementer.id,
      orcaAgent: implementer.orcaAgent,
      invokeHint: implementer.invokeHint,
    });

    const task = createOrchestrationTask(orcaCli, {
      title: `Implement ${repo.github}#${job.issue_number}`,
      displayName: `issue-${job.issue_number}-implement`,
      spec,
    });
    if (!task.ok) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: task.error,
      });
      return { ok: false, jobId: job.id, message: task.error };
    }

    const disp = dispatchTask(orcaCli, {
      taskId: task.value.taskId,
      to: job.implementer_terminal_handle,
      from: job.controller_terminal_handle!,
    });
    if (!disp.ok) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: disp.error,
        implementer_task_id: task.value.taskId,
      });
      return { ok: false, jobId: job.id, message: disp.error };
    }

    job = ledger.updateJob(job.id, {
      state: "implementing",
      implementer_task_id: task.value.taskId,
      implementer_dispatch_id: disp.value.dispatchId,
    });
    setWorktreeProgress(
      orcaCli,
      job.worktree_id!,
      `harness: implementing via ${implementer.id}`,
      "in-progress",
    );
    log(
      `dispatched task=${task.value.taskId} dispatch=${disp.value.dispatchId ?? "?"}`,
    );
  } else {
    log(
      `task already dispatched: ${job.implementer_task_id} (state=${job.state})`,
    );
    if (job.state !== "implementing") {
      job = ledger.updateJob(job.id, { state: "implementing" });
    }
  }

  // 6) Wait worker_done
  if (job.state === "implementing") {
    const timeoutMs = config.implementTimeoutMinutes * 60_000;
    log(
      `waiting worker_done up to ${config.implementTimeoutMinutes} minutes…`,
    );
    const done = waitWorkerDone(orcaCli, {
      controllerHandle: job.controller_terminal_handle!,
      taskId: job.implementer_task_id!,
      dispatchId: job.implementer_dispatch_id,
      timeoutMs,
      onTick: (info) => log(info),
    });

    if (!done.ok) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: done.error,
      });
      setWorktreeProgress(
        orcaCli,
        job.worktree_id!,
        `harness: blocked — ${done.error}`,
        "in-progress",
      );
      return {
        ok: false,
        jobId: job.id,
        message: done.error,
        details: { message: done.message },
      };
    }
    log("received worker_done");
  }

  // 7) Verify commits, no push
  const worktreePath = job.worktree_path!;
  const baseSha = job.base_sha!;
  const headSha = revParse(worktreePath, "HEAD");
  if (!headSha) {
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: "cannot read HEAD after implement",
    });
    return { ok: false, jobId: job.id, message: "cannot read HEAD" };
  }

  const commits = commitCountSince(worktreePath, baseSha);
  const logLines = logOnelineSince(worktreePath, baseSha);
  const dirty = statusPorcelain(worktreePath);
  const branch = currentBranch(worktreePath) ?? job.branch ?? "";
  const pushed = branch ? isPushed(worktreePath, branch) : false;

  if (headSha === baseSha || commits < 1) {
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: "implement finished but no commits since base",
      head_sha: headSha,
    });
    setWorktreeProgress(
      orcaCli,
      job.worktree_id!,
      "harness: blocked — no commits",
      "in-progress",
    );
    return {
      ok: false,
      jobId: job.id,
      message: "no commits since base SHA",
      details: { baseSha, headSha, dirty },
    };
  }

  if (pushed) {
    // M2 must not push; if agent did, block for human review.
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: "branch has upstream (unexpected push in M2)",
      head_sha: headSha,
    });
    return {
      ok: false,
      jobId: job.id,
      message: "branch appears pushed; M2 forbids push",
      details: { branch, headSha },
    };
  }

  job = ledger.updateJob(job.id, {
    state: "awaiting_audit",
    head_sha: headSha,
    last_error: null,
  });
  setWorktreeProgress(
    orcaCli,
    job.worktree_id!,
    `harness: implement done head=${headSha.slice(0, 7)} commits=${commits} (M2 stop, no PR)`,
    "in-review",
  );

  return {
    ok: true,
    jobId: job.id,
    message: "implement complete; stopped before audit/PR (M2)",
    details: {
      repo: job.repo,
      issue: job.issue_number,
      state: job.state,
      baseSha,
      headSha,
      branch,
      commits,
      log: logLines,
      dirty: dirty || "(clean)",
      worktreePath,
      implementerProfile: implementer.id,
    },
  };
}
