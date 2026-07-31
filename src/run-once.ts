import { randomUUID } from "node:crypto";
import {
  defaultLedgerPath,
  defaultLockPath,
  getImplementerProfile,
} from "./config.js";
import { trackedDirty } from "./audit-gate.js";
import {
  checkAncestor,
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
import { loadRuntimeConfig, validateProjectRuntime } from "./project.js";
import { renderImplementerSpec } from "./prompts.js";
import {
  IMPLEMENT_NO_COMMITS_ERROR,
  isStaleImplementationTaskStatusError,
} from "./reconcile.js";
import { requireOrcaCli, orcaStatus } from "./orca.js";
import {
  dispatchTaskEnsured,
  ensureAgentTerminal,
  ensureControllerTerminal,
  ensureIssueWorktree,
  orchestrationTaskStatus,
  setWorktreeProgress,
  waitWorkerDone,
  type DispatchWait,
} from "./orca-runtime.js";
import type { Job, RepoConfig, RuntimeHarnessConfig } from "./types.js";

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

const HARD_WORKTREE_DISCOVERY_ERROR_PREFIX =
  "worktree discovery blocked: ";

export function runOnce(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  repoFilter?: string;
  /** If set, resume/force this issue number instead of picking. */
  issueNumber?: number;
  /** Revalidate this exact blocked implementation while locked. */
  blockedImplementationRecovery?: BlockedImplementationRecovery;
  /** Refuse legacy blocked-job retries when called by automatic coordination. */
  automaticCoordination?: boolean;
}): RunOnceResult {
  const config = loadRuntimeConfig(options.configPath);
  const lockPath = options.lockPath ?? defaultLockPath();
  const lock = acquireLock(lockPath);
  if (!lock.ok) {
    return { ok: false, message: lock.error ?? "lock failed" };
  }

  const ledger = new Ledger(options.ledgerPath ?? defaultLedgerPath());
  try {
    return runOnceLocked(config, ledger, {
      ...options,
      lockPath,
      releaseLock: lock.release,
    });
  } finally {
    ledger.close();
    lock.release();
  }
}

function runOnceLocked(
  config: RuntimeHarnessConfig,
  ledger: Ledger,
  options: {
    repoFilter?: string;
    issueNumber?: number;
    blockedImplementationRecovery?: BlockedImplementationRecovery;
    automaticCoordination?: boolean;
    lockPath: string;
    releaseLock: () => void;
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
      (job.last_error !== IMPLEMENT_NO_COMMITS_ERROR &&
        !isStaleImplementationTaskStatusError(job.last_error)) ||
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
    const taskStatus =
      orchestrationTaskStatus(
        orcaCli,
        blockedRecovery.taskId,
      )?.toLowerCase() ?? "unavailable";
    if (
      blockedRecovery.action === "finalize" &&
      taskStatus !== "completed"
    ) {
      return {
        ok: false,
        jobId: job!.id,
        message:
          "blocked implementation task must be completed before finalize " +
          `(Orca status=${taskStatus})`,
      };
    }
    if (
      blockedRecovery.action === "retry" &&
      taskStatus !== "completed" &&
      taskStatus !== "failed"
    ) {
      return {
        ok: false,
        jobId: job!.id,
        message: "blocked implementation task is not confirmed ended",
      };
    }
  }

  if (job) {
    log(`resuming active job ${job.id} state=${job.state} ${job.repo}#${job.issue_number}`);
    const project = ledger.resolveJobProject(job.id, config.repositories);
    if (!project.ok) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: project.error,
      });
      return { ok: false, jobId: job.id, message: project.error };
    }
    job = project.job;
    repo = project.project;
    const runtime = validateProjectRuntime(repo, orcaCli);
    if (!runtime.ok) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: runtime.error,
      });
      return { ok: false, jobId: job.id, message: runtime.error };
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
        const ancestry = checkAncestor(worktreePath!, baseSha, headSha);
        if (!ancestry.ok || !ancestry.isAncestor) {
          const error = ancestry.ok
            ? "implementation recovery HEAD is not a descendant of base SHA"
            : `cannot verify implementation recovery ancestry: ${ancestry.error}`;
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
        if (options.automaticCoordination) {
          return {
            ok: false,
            jobId: job.id,
            message: `job is blocked: ${job.last_error ?? "no detail"}`,
          };
        }
        // Legacy direct run-once may retry transient Orca failures before a
        // task was dispatched. Automatic coordination stops at every block.
        const lastError = job.last_error ?? "";
        const retryable =
          !job.implementer_task_id &&
          !lastError.startsWith(HARD_WORKTREE_DISCOVERY_ERROR_PREFIX) &&
          lastError.toLowerCase().includes("orca");
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
      const runtime = validateProjectRuntime(r, orcaCli);
      if (!runtime.ok) {
        return {
          ok: false,
          message: `project runtime invalid for ${r.github}: ${runtime.error}`,
        };
      }
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
        project: r,
        issue: pick.selected,
        baseSha: refreshed.sha,
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
      job.id,
      implementer,
    );
    if (!wt.ok) {
      job = ledger.updateJob(job.id, {
        state: wt.retryable ? "claimed" : "blocked",
        last_error: wt.retryable
          ? wt.error
          : `${HARD_WORKTREE_DISCOVERY_ERROR_PREFIX}${wt.error}`,
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

    const desiredBranch = `agent/issue-${job.issue_number}-${job.id.slice(0, 8)}`;
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
      last_error: null,
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

  const jobChangedWhileWaiting = (): RunOnceResult => ({
    ok: false,
    jobId: job!.id,
    message: "job changed while waiting for implementation; retry coordination cycle",
  });
  const blockFailedImplementation = (taskId: string): RunOnceResult => {
    const error =
      `implementation task ${taskId} is not completed ` +
      "(Orca status=failed)";
    const updated = ledger.updateJobIf(job!.id, job!.revision, {
      state: "blocked",
      last_error: error,
    });
    if (!updated) return jobChangedWhileWaiting();
    job = updated;
    setWorktreeProgress(
      orcaCli,
      job.worktree_id!,
      `harness: blocked — ${error}`,
      "in-progress",
    );
    return { ok: false, jobId: job.id, message: error };
  };
  const failedPendingTaskId =
    job.dispatch_probe_pending === 1 &&
    job.implementer_task_id &&
    orchestrationTaskStatus(
      orcaCli,
      job.implementer_task_id,
    )?.toLowerCase() === "failed"
      ? job.implementer_task_id
      : null;
  if (
    failedPendingTaskId &&
    job.worktree_path &&
    job.base_sha
  ) {
    const head = revParse(job.worktree_path, "HEAD");
    if (
      head &&
      head !== job.base_sha &&
      commitCountSince(job.worktree_path, job.base_sha) >= 1
    ) {
      return blockFailedImplementation(failedPendingTaskId);
    }
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
    const dispatchBaseSha = job.base_sha;
    const dispatchWorktreePath = job.worktree_path;
    const allowedTrackedChanges =
      blockedRecovery?.action === "retry"
        ? trackedDirty(dispatchWorktreePath)
        : null;
    const dispatchFixedPointError = (): string | null => {
      const head = revParse(dispatchWorktreePath, "HEAD");
      if (head !== dispatchBaseSha) {
        return (
          "implementation HEAD changed before implementation dispatch: " +
          `expected ${dispatchBaseSha}, got ${head ?? "unreadable"}`
        );
      }
      const dirty = trackedDirty(dispatchWorktreePath);
      if (blockedRecovery?.action === "retry") {
        return dirty === allowedTrackedChanges
          ? null
          : "tracked files changed while waiting to retry implementation";
      }
      return dirty
        ? `tracked files dirty before implementation dispatch:\n${dirty}`
        : null;
    };

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
    let taskCreateGuardError: string | null = null;
    let dispatchWaitError: string | null = null;
    let dispatchWaitSnapshot: {
      revision: number;
      state: Job["state"];
      taskId: string | null;
      dispatchId: string | null;
      terminalHandle: string | null;
    } | null = null;
    const beforeDispatchWait = (_wait: DispatchWait) => {
      const currentJob = job!;
      dispatchWaitSnapshot = {
        revision: currentJob.revision,
        state: currentJob.state,
        taskId: currentJob.implementer_task_id,
        dispatchId: currentJob.implementer_dispatch_id,
        terminalHandle: currentJob.implementer_terminal_handle,
      };
      options.releaseLock();
    };
    const afterDispatchWait = (wait: DispatchWait): string | null => {
      const reacquired = acquireLock(options.lockPath);
      if (!reacquired.ok) {
        dispatchWaitError =
          reacquired.error ?? "failed to reacquire lock after dispatch wait";
        return dispatchWaitError;
      }
      const current = ledger.getJob(jobId);
      const expected = dispatchWaitSnapshot;
      if (
        !current ||
        !expected ||
        current.revision !== expected.revision ||
        current.state !== expected.state ||
        current.implementer_task_id !== expected.taskId ||
        current.implementer_dispatch_id !== expected.dispatchId ||
        current.implementer_terminal_handle !== expected.terminalHandle
      ) {
        dispatchWaitError =
          "job changed while waiting for implementation dispatch; retry coordination cycle";
        return dispatchWaitError;
      }
      job = current;
      if (wait.kind === "terminal_idle") {
        taskCreateGuardError = dispatchFixedPointError();
        return taskCreateGuardError;
      }
      return null;
    };
    const ensured = dispatchTaskEnsured(orcaCli, {
      title: `Implement ${repo.github}#${job.issue_number}`,
      displayName: `issue-${job.issue_number}-implement`,
      spec,
      to: dispatchHandle,
      from: job.controller_terminal_handle!,
      onLog: log,
      existingDispatch,
      beforeWait: beforeDispatchWait,
      afterWait: afterDispatchWait,
      beforeTaskCreate: () => {
        taskCreateGuardError = dispatchFixedPointError();
        return taskCreateGuardError;
      },
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
    if (dispatchWaitError) {
      return {
        ok: false,
        jobId,
        message: dispatchWaitError,
      };
    }
    if (!ensured.ok) {
      const hasLastTask = ensured.lastTaskId !== undefined;
      const taskId = ensured.lastTaskId ?? job.implementer_task_id;
      const dispatchId = hasLastTask
        ? ensured.lastDispatchId ?? null
        : job.implementer_dispatch_id;
      const shouldBlock =
        taskCreateGuardError !== null ||
        ensured.kind === "exhausted" ||
        (hasLastTask && dispatchId === null) ||
        blockedRecovery?.action === "retry";
      const dispatchError =
        taskCreateGuardError ??
        `dispatch ${ensured.kind}: ${ensured.error}`;
      const updated = ledger.updateJobIf(job.id, job.revision, {
        state: shouldBlock ? "blocked" : job.state,
        last_error: dispatchError,
        implementer_terminal_handle: ensured.to,
        implementer_task_id: taskId,
        implementer_dispatch_id: dispatchId,
        dispatch_attempt: hasLastTask
          ? ensured.lastAttempt ?? 0
          : job.dispatch_attempt,
        dispatch_probe_pending:
          shouldBlock || !taskId ? 0 : 1,
      });
      if (!updated) return jobChangedWhileWaiting();
      job = updated;
      setWorktreeProgress(
        orcaCli,
        job.worktree_id!,
        `harness: ${dispatchError}`.slice(0, 180),
        "in-progress",
      );
      return { ok: false, jobId: job.id, message: ensured.error };
    }

    const dispatchAccepted = ledger.updateJobIf(job.id, job.revision, {
      state: "implementing",
      implementer_task_id: ensured.taskId,
      implementer_dispatch_id: ensured.dispatchId,
      implementer_terminal_handle: ensured.to,
      dispatch_attempt: ensured.attempt,
      dispatch_probe_pending: 0,
      last_error: null,
    });
    if (!dispatchAccepted) return jobChangedWhileWaiting();
    job = dispatchAccepted;
    if (ensured.taskId === failedPendingTaskId) {
      return blockFailedImplementation(ensured.taskId);
    }
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

  // 6) Wait worker_done unless a completed task already has commits (M5).
  let completedTaskRecovery = false;
  if (job.state === "implementing") {
    const earlyHead =
      job.worktree_path && job.base_sha
        ? revParse(job.worktree_path, "HEAD")
        : null;
    const earlyCommits =
      job.worktree_path && job.base_sha
        ? commitCountSince(job.worktree_path, job.base_sha)
        : 0;
    const hasEarlyCommits = Boolean(
      earlyHead &&
        job.base_sha &&
        earlyHead !== job.base_sha &&
        earlyCommits >= 1,
    );
    const earlyTaskStatus = hasEarlyCommits
      ? orchestrationTaskStatus(
          orcaCli,
          job.implementer_task_id!,
        )?.toLowerCase() ?? "unavailable"
      : null;
    if (earlyTaskStatus === "failed") {
      return blockFailedImplementation(job.implementer_task_id!);
    }
    if (earlyTaskStatus === "completed") {
      completedTaskRecovery = true;
      log(
        `M5 resume: completed task has ${earlyCommits} commits; skipping worker_done wait`,
      );
    } else {
      if (earlyTaskStatus) {
        log(
          `commits exist but task status=${earlyTaskStatus}; waiting for worker_done`,
        );
      }
      const timeoutMs = config.implementTimeoutMinutes * 60_000;
      log(
        `waiting worker_done up to ${config.implementTimeoutMinutes} minutes…`,
      );
      const waitRevision = job.revision;
      const waitTaskId = job.implementer_task_id!;
      const waitDispatchId = job.implementer_dispatch_id;
      options.releaseLock();
      const done = waitWorkerDone(orcaCli, {
        controllerHandle: job.controller_terminal_handle!,
        taskId: waitTaskId,
        dispatchId: waitDispatchId,
        workerHandle: job.implementer_terminal_handle,
        timeoutMs,
        onTick: (info) => log(info),
      });
      const reacquired = acquireLock(options.lockPath);
      if (!reacquired.ok) {
        return {
          ok: false,
          jobId: job.id,
          message: reacquired.error ?? "failed to reacquire lock after worker wait",
        };
      }
      const current = ledger.getJob(job.id);
      if (
        !current ||
        current.revision !== waitRevision ||
        current.state !== "implementing" ||
        current.implementer_task_id !== waitTaskId ||
        current.implementer_dispatch_id !== waitDispatchId
      ) {
        return jobChangedWhileWaiting();
      }
      job = current;

      if (!done.ok) {
        // Last-chance recovery: a completed task may have lost worker_done.
        const lateHead =
          job.worktree_path && job.base_sha
            ? revParse(job.worktree_path, "HEAD")
            : null;
        const lateCommits =
          job.worktree_path && job.base_sha
            ? commitCountSince(job.worktree_path, job.base_sha)
            : 0;
        let recoveryError = done.error;
        if (
          !done.escalated &&
          lateHead &&
          job.base_sha &&
          lateHead !== job.base_sha &&
          lateCommits >= 1
        ) {
          const taskStatus =
            orchestrationTaskStatus(
              orcaCli,
              job.implementer_task_id!,
            )?.toLowerCase() ?? "unavailable";
          if (taskStatus === "completed") {
            recoveryError = "";
            completedTaskRecovery = true;
            log(
              `worker_done missing but completed task has commits; continuing finalize (M5)`,
            );
          } else {
            recoveryError =
              `implementation task ${job.implementer_task_id} is not completed ` +
              `(Orca status=${taskStatus})`;
          }
        }
        if (recoveryError) {
          const updated = ledger.updateJobIf(job.id, job.revision, {
            state: "blocked",
            last_error: recoveryError,
            intervention_json: done.intervention
              ? JSON.stringify({
                  ...done.intervention,
                  sourceState: "implementing",
                  role: "implementer",
                  headSha: lateHead,
                })
              : null,
            intervention_resolved_at: null,
          });
          if (!updated) return jobChangedWhileWaiting();
          job = updated;
          setWorktreeProgress(
            orcaCli,
            job.worktree_id!,
            `harness: blocked — ${recoveryError}`,
            "in-progress",
          );
          return {
            ok: false,
            jobId: job.id,
            message: recoveryError,
            details: { message: done.message },
          };
        }
      } else {
        if (
          orchestrationTaskStatus(
            orcaCli,
            job.implementer_task_id!,
          )?.toLowerCase() === "failed"
        ) {
          return blockFailedImplementation(job.implementer_task_id!);
        }
        log("received worker_done");
      }
    }
  }

  // 7) Verify commits, no push
  const worktreePath = job.worktree_path!;
  const baseSha = job.base_sha!;
  const headSha = revParse(worktreePath, "HEAD");
  if (!headSha) {
    const updated = ledger.updateJobIf(job.id, job.revision, {
      state: "blocked",
      last_error: "cannot read HEAD after implement",
    });
    if (!updated) return jobChangedWhileWaiting();
    job = updated;
    return { ok: false, jobId: job.id, message: "cannot read HEAD" };
  }

  const ancestry = checkAncestor(worktreePath, baseSha, headSha);
  if (!ancestry.ok || !ancestry.isAncestor) {
    const error = ancestry.ok
      ? "implementation HEAD is not a descendant of base SHA"
      : `cannot verify implementation ancestry: ${ancestry.error}`;
    const updated = ledger.updateJobIf(job.id, job.revision, {
      state: "blocked",
      last_error: error,
      head_sha: headSha,
    });
    if (!updated) return jobChangedWhileWaiting();
    job = updated;
    setWorktreeProgress(
      orcaCli,
      job.worktree_id!,
      `harness: blocked — ${error}`,
      "in-progress",
    );
    return { ok: false, jobId: job.id, message: error };
  }

  const commits = commitCountSince(worktreePath, baseSha);
  const logLines = logOnelineSince(worktreePath, baseSha);
  const dirty = statusPorcelain(worktreePath);
  const branch = currentBranch(worktreePath) ?? job.branch ?? "";
  const pushed = branch ? isPushed(worktreePath, branch) : false;

  if (headSha === baseSha || commits < 1) {
    const updated = ledger.updateJobIf(job.id, job.revision, {
      state: "blocked",
      last_error: IMPLEMENT_NO_COMMITS_ERROR,
      head_sha: headSha,
    });
    if (!updated) return jobChangedWhileWaiting();
    job = updated;
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

  if (completedTaskRecovery) {
    const tracked = trackedDirty(worktreePath);
    if (tracked) {
      const error =
        "tracked files dirty or unreadable after completed task recovery:\n" +
        tracked;
      const updated = ledger.updateJobIf(job.id, job.revision, {
        state: "blocked",
        last_error: error,
        head_sha: headSha,
      });
      if (!updated) return jobChangedWhileWaiting();
      job = updated;
      setWorktreeProgress(
        orcaCli,
        job.worktree_id!,
        "harness: blocked — completed task recovery is not clean",
        "in-progress",
      );
      return { ok: false, jobId: job.id, message: error };
    }
  }

  if (pushed) {
    // M2 must not push; if agent did, block for human review.
    const updated = ledger.updateJobIf(job.id, job.revision, {
      state: "blocked",
      last_error: "branch has upstream (unexpected push in M2)",
      head_sha: headSha,
    });
    if (!updated) return jobChangedWhileWaiting();
    job = updated;
    return {
      ok: false,
      jobId: job.id,
      message: "branch appears pushed; M2 forbids push",
      details: { branch, headSha },
    };
  }

  const completed = ledger.updateJobIf(job.id, job.revision, {
    state: "awaiting_audit",
    head_sha: headSha,
    dispatch_attempt: 0,
    dispatch_probe_pending: 0,
    last_error: null,
    intervention_json: null,
    intervention_resolved_at: null,
  });
  if (!completed) return jobChangedWhileWaiting();
  job = completed;
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
