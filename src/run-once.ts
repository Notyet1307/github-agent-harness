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
  git,
  isPushed,
  logOnelineSince,
  refreshBaseRef,
  revParse,
  statusPorcelain,
} from "./git.js";
import { Ledger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import { pickForRepo } from "./picker.js";
import { renderImplementerSpec } from "./prompts.js";
import { IMPLEMENT_NO_COMMITS_ERROR } from "./reconcile.js";
import { requireOrcaCli, orcaStatus } from "./orca.js";
import {
  dispatchTaskEnsured,
  ensureAgentTerminal,
  ensureControllerTerminal,
  ensureIssueWorktree,
  orchestrationTaskStatus,
  setWorktreeProgress,
  waitWorkerDone,
} from "./orca-runtime.js";
import type { HarnessConfig, Job, RepoConfig } from "./types.js";

export type RunOnceResult = {
  ok: boolean;
  jobId?: string;
  message: string;
  details?: Record<string, unknown>;
};

type BlockedImplementationRecovery = {
  action: "retry" | "finalize";
  jobId: string;
  taskId: string;
  dispatchId: string | null;
};

export function runOnce(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  repoFilter?: string;
  /** If set, resume/force this issue number instead of picking. */
  issueNumber?: number;
  /** Revalidate this exact blocked implementation while locked. */
  blockedImplementationRecovery?: BlockedImplementationRecovery;
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
  options: {
    repoFilter?: string;
    issueNumber?: number;
    blockedImplementationRecovery?: BlockedImplementationRecovery;
  },
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
  const blockedRecovery = options.blockedImplementationRecovery;

  if (
    blockedRecovery &&
    (!job ||
      job.id !== blockedRecovery.jobId ||
      job.state !== "blocked" ||
      job.last_error !== IMPLEMENT_NO_COMMITS_ERROR ||
      job.implementer_task_id !== blockedRecovery.taskId ||
      job.implementer_dispatch_id !== blockedRecovery.dispatchId)
  ) {
    return {
      ok: false,
      jobId: job?.id,
      message: "blocked implementation changed before recovery",
    };
  }
  if (blockedRecovery) {
    const taskStatus = orchestrationTaskStatus(
      orcaCli,
      blockedRecovery.taskId,
    )?.toLowerCase();
    if (taskStatus !== "completed" && taskStatus !== "failed") {
      return {
        ok: false,
        jobId: job!.id,
        message: "blocked implementation task is not confirmed ended",
      };
    }
  }

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
      if (blockedRecovery) {
        const worktreePath = job.worktree_path;
        const baseSha = job.base_sha;
        const headSha = worktreePath
          ? revParse(worktreePath, "HEAD")
          : null;
        const tracked = worktreePath
          ? git(worktreePath, ["status", "--porcelain", "-uno"])
          : null;
        if (!baseSha || !headSha || !tracked?.ok) {
          const error =
            "implementation recovery revalidation failed: unreadable base, HEAD, or tracked status";
          job = ledger.updateJob(job.id, { last_error: error });
          return { ok: false, jobId: job.id, message: error };
        }
        if (headSha !== baseSha) {
          const commits = commitCountSince(worktreePath!, baseSha);
          if (commits < 1 || tracked.stdout) {
            const error =
              "implementation recovery revalidation found a changed or dirty HEAD";
            job = ledger.updateJob(job.id, { last_error: error });
            return { ok: false, jobId: job.id, message: error };
          }
          log("implementation commits landed before recovery; finalizing");
          job = ledger.updateJob(job.id, {
            state: "implementing",
            last_error: null,
            head_sha: headSha,
          });
        } else if (blockedRecovery.action === "retry") {
          log("explicitly retrying blocked implementation");
          job = ledger.updateJob(job.id, {
            implementer_terminal_handle: null,
            implementer_task_id: null,
            implementer_dispatch_id: null,
            dispatch_attempt: 0,
            dispatch_probe_pending: 0,
            last_error: null,
            head_sha: null,
          });
        } else {
          const error =
            "implementation finalize revalidation found no commits since base";
          job = ledger.updateJob(job.id, { last_error: error });
          return { ok: false, jobId: job.id, message: error };
        }
      } else {
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
      const refreshed = refreshBaseRef(r.localPath, r.baseRef);
      if (!refreshed.ok) {
        return {
          ok: false,
          message: `base refresh failed for ${r.github}: ${refreshed.error}`,
        };
      }
      log(`refreshed ${r.github} ${r.baseRef}=${refreshed.sha}`);

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
      claimed = ledger.updateJob(result.job.id, {
        base_sha: refreshed.sha,
      });
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

  const hasWorktreeId = job.worktree_id !== null;
  const hasWorktreePath = job.worktree_path !== null;
  if (hasWorktreeId !== hasWorktreePath) {
    const error =
      "incomplete worktree provenance: worktree_id and worktree_path must both be present";
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: error,
    });
    return { ok: false, jobId: job.id, message: error };
  }
  const needsWorktree = !hasWorktreeId;

  if (needsWorktree && !job.base_sha) {
    const refreshed = refreshBaseRef(repo.localPath, repo.baseRef);
    if (!refreshed.ok) {
      job = ledger.updateJob(job.id, {
        state: "claimed",
        last_error: refreshed.error,
      });
      return {
        ok: false,
        jobId: job.id,
        message: `base refresh failed for ${repo.github}: ${refreshed.error}`,
      };
    }
    log(`refreshed ${repo.github} ${repo.baseRef}=${refreshed.sha}`);
    job = ledger.updateJob(job.id, {
      base_sha: refreshed.sha,
      last_error: null,
    });
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
  if (needsWorktree) {
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

    const actualBaseSha = revParse(wt.value.worktreePath, "HEAD");
    if (!actualBaseSha) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: "failed to read base SHA",
        worktree_id: wt.value.worktreeId,
        worktree_path: wt.value.worktreePath,
      });
      return { ok: false, jobId: job.id, message: "failed to read base SHA" };
    }
    const expectedBaseSha = job.base_sha;
    if (!expectedBaseSha || actualBaseSha !== expectedBaseSha) {
      const error = `worktree base SHA mismatch: expected ${expectedBaseSha ?? "(missing)"} from ${repo.baseRef}, got ${actualBaseSha}`;
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: error,
        worktree_id: wt.value.worktreeId,
        worktree_path: wt.value.worktreePath,
        implementer_terminal_handle: wt.value.agentTerminalHandle,
      });
      return {
        ok: false,
        jobId: job.id,
        message: error,
        details: { expectedBaseSha, actualBaseSha },
      };
    }
    const baseSha = expectedBaseSha;

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

  const needsImplementerDispatch =
    !job.implementer_task_id || job.dispatch_probe_pending === 1;
  let liveImplementerHandle = job.implementer_terminal_handle;

  // Orca terminal handles are not durable across restarts. Resolve a live
  // terminal immediately before a new or pending dispatch.
  if (needsImplementerDispatch) {
    liveImplementerHandle = job.worktree_id
      ? ensureAgentTerminal(
          orcaCli,
          job.worktree_id,
          implementer,
          `issue-${job.issue_number}-${implementer.orcaAgent}`,
        )
      : null;
    if (
      liveImplementerHandle &&
      liveImplementerHandle !== job.implementer_terminal_handle
    ) {
      job = ledger.updateJob(job.id, {
        implementer_terminal_handle: liveImplementerHandle,
      });
    }
  }

  // 4) Create/dispatch and confirm that the agent accepted the task.
  // If the controller crashed during the probe window, resume that task first.
  if (needsImplementerDispatch) {
    const dispatchHandle = liveImplementerHandle;
    if (!dispatchHandle) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: "no implementer terminal handle",
      });
      return {
        ok: false,
        jobId: job.id,
        message:
          "no implementer terminal handle (is codex/pi installed in Orca?)",
      };
    }
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

    const jobId = job.id;
    const worktreeId = job.worktree_id;
    const issueNumber = job.issue_number;
    const existingDispatch =
      job.dispatch_probe_pending === 1 && job.implementer_task_id
        ? {
            taskId: job.implementer_task_id,
            dispatchId: job.implementer_dispatch_id,
            to: dispatchHandle,
            attempt: (job.dispatch_attempt === 2 ? 2 : 1) as 1 | 2,
          }
        : undefined;
    const ensured = dispatchTaskEnsured(orcaCli, {
      title: `Implement ${repo.github}#${job.issue_number}`,
      displayName: `issue-${job.issue_number}-implement`,
      spec,
      to: dispatchHandle,
      from: job.controller_terminal_handle!,
      onLog: log,
      existingDispatch,
      onDispatched: (event) => {
        job = ledger.updateJob(jobId, {
          state: "implementing",
          implementer_terminal_handle: event.to,
          implementer_task_id: event.taskId,
          implementer_dispatch_id: event.dispatchId,
          dispatch_attempt: event.attempt,
          dispatch_probe_pending: 1,
          last_error: null,
        });
      },
      recreateAgentTerminal: () => {
        if (!worktreeId) return null;
        const replacement = ensureAgentTerminal(
          orcaCli,
          worktreeId,
          implementer,
          `issue-${issueNumber}-${implementer.orcaAgent}`,
          { forceNew: true },
        );
        if (replacement) {
          job = ledger.updateJob(jobId, {
            implementer_terminal_handle: replacement,
          });
        }
        return replacement;
      },
    });
    if (!ensured.ok) {
      const hasLastTask = ensured.lastTaskId !== undefined;
      const taskId = ensured.lastTaskId ?? job.implementer_task_id;
      const dispatchId = hasLastTask
        ? ensured.lastDispatchId ?? null
        : job.implementer_dispatch_id;
      const shouldBlock =
        ensured.kind === "exhausted" ||
        (hasLastTask && dispatchId === null) ||
        blockedRecovery?.action === "retry";
      job = ledger.updateJob(job.id, {
        state: shouldBlock ? "blocked" : job.state,
        last_error: `dispatch ${ensured.kind}: ${ensured.error}`,
        implementer_terminal_handle: ensured.to,
        implementer_task_id: taskId,
        implementer_dispatch_id: dispatchId,
        dispatch_attempt: hasLastTask
          ? ensured.lastAttempt ?? 0
          : job.dispatch_attempt,
        dispatch_probe_pending:
          shouldBlock || !taskId ? 0 : 1,
      });
      setWorktreeProgress(
        orcaCli,
        job.worktree_id!,
        `harness: dispatch ${ensured.kind} — ${ensured.error}`.slice(0, 180),
        "in-progress",
      );
      return { ok: false, jobId: job.id, message: ensured.error };
    }

    job = ledger.updateJob(job.id, {
      state: "implementing",
      implementer_task_id: ensured.taskId,
      implementer_dispatch_id: ensured.dispatchId,
      implementer_terminal_handle: ensured.to,
      dispatch_attempt: ensured.attempt,
      dispatch_probe_pending: 0,
      last_error: null,
    });
    setWorktreeProgress(
      orcaCli,
      job.worktree_id!,
      `harness: implementing via ${implementer.id} (dispatch attempt ${ensured.attempt})`,
      "in-progress",
    );
    log(
      `dispatch ok attempt=${ensured.attempt} task=${ensured.taskId} dispatch=${ensured.dispatchId ?? "?"} (${ensured.acceptReason})`,
    );
  } else {
    log(
      `task already dispatched: ${job.implementer_task_id} (state=${job.state})`,
    );
    if (job.state !== "implementing") {
      job = ledger.updateJob(job.id, { state: "implementing" });
    }
  }

  // 6) Wait worker_done — unless crash-recovery already sees commits (M5)
  if (job.state === "implementing") {
    const earlyHead =
      job.worktree_path && job.base_sha
        ? revParse(job.worktree_path, "HEAD")
        : null;
    const earlyCommits =
      job.worktree_path && job.base_sha
        ? commitCountSince(job.worktree_path, job.base_sha)
        : 0;
    if (
      earlyHead &&
      job.base_sha &&
      earlyHead !== job.base_sha &&
      earlyCommits >= 1
    ) {
      log(
        `M5 resume: commits already present (${earlyCommits}); skipping worker_done wait`,
      );
    } else {
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
        // Last-chance recovery: commits may have landed without worker_done
        const lateHead =
          job.worktree_path && job.base_sha
            ? revParse(job.worktree_path, "HEAD")
            : null;
        const lateCommits =
          job.worktree_path && job.base_sha
            ? commitCountSince(job.worktree_path, job.base_sha)
            : 0;
        if (
          lateHead &&
          job.base_sha &&
          lateHead !== job.base_sha &&
          lateCommits >= 1
        ) {
          log(
            `worker_done missing but commits exist; continuing finalize (M5)`,
          );
        } else {
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
      } else {
        log("received worker_done");
      }
    }
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
      last_error: IMPLEMENT_NO_COMMITS_ERROR,
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
    dispatch_attempt: 0,
    dispatch_probe_pending: 0,
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
