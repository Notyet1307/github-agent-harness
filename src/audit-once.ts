import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultLedgerPath,
  defaultLockPath,
  getAuditorProfile,
  getImplementerProfile,
} from "./config.js";
import {
  auditResultMatchesShas,
  evaluateAuditGate,
  loadAuditResult,
  trackedDirty,
  type GateDecision,
} from "./audit-gate.js";
import {
  checkAncestor,
  currentBranch,
  git,
  logOnelineSince,
  revParse,
} from "./git.js";
import { Ledger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import { orcaStatus, requireOrcaCli } from "./orca.js";
import { loadRuntimeConfig, validateProjectRuntime } from "./project.js";
import {
  dispatchTaskEnsured,
  ensureAgentTerminal,
  ensureControllerTerminal,
  orchestrationTaskStatus,
  setWorktreeProgress,
  waitWorkerDone,
  type DispatchWait,
} from "./orca-runtime.js";
import { renderAuditorSpec, renderReworkSpec } from "./prompts.js";
import { REWORK_NO_COMMITS_AFTER_AUDITED_HEAD_ERROR } from "./reconcile.js";
import type { Job, RepoConfig, RuntimeHarnessConfig } from "./types.js";

export type AuditOnceResult = {
  ok: boolean;
  jobId?: string;
  message: string;
  details?: Record<string, unknown> & {
    gate?: GateDecision;
    gateFail?: boolean;
  };
};

type WaitLockOptions = {
  lockPath: string;
  releaseLock: () => void;
};

export function auditOnce(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  /** When true, after fail rework once and re-audit until pass/block (M3 loop). */
  withRework?: boolean;
}): AuditOnceResult {
  const config = loadRuntimeConfig(options.configPath);
  const lockPath = options.lockPath ?? defaultLockPath();
  const lock = acquireLock(lockPath);
  if (!lock.ok) {
    return { ok: false, message: lock.error ?? "lock failed" };
  }
  const ledger = new Ledger(options.ledgerPath ?? defaultLedgerPath());
  try {
    return auditOnceLocked(config, ledger, {
      withRework: options.withRework ?? true,
      lockPath,
      releaseLock: lock.release,
    });
  } finally {
    ledger.close();
    lock.release();
  }
}

function auditOnceLocked(
  config: RuntimeHarnessConfig,
  ledger: Ledger,
  options: {
    withRework: boolean;
    lockPath: string;
    releaseLock: () => void;
  },
): AuditOnceResult {
  const log = (msg: string) => {
    process.stdout.write(`[audit-once] ${msg}\n`);
  };

  const orcaCli = requireOrcaCli(config);
  const st = orcaStatus(orcaCli);
  if (!st.ok) {
    return { ok: false, message: `orca not ready: ${st.error ?? "unknown"}` };
  }

  let job = ledger.getActiveJob();
  if (!job) {
    return { ok: false, message: "no active job" };
  }
  const project = ledger.resolveJobProject(job.id, config.repositories);
  if (!project.ok) {
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: project.error,
    });
    return { ok: false, jobId: job.id, message: project.error };
  }
  job = project.job;
  const repo = project.project;
  const runtime = validateProjectRuntime(repo, orcaCli);
  if (!runtime.ok) {
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: runtime.error,
    });
    return { ok: false, jobId: job.id, message: runtime.error };
  }

  if (job.state === "audit_passed") {
    return {
      ok: true,
      jobId: job.id,
      message: "already audit_passed; use harness publish-once for M4",
      details: { head_sha: job.head_sha, audit_round: job.audit_round },
    };
  }
  if (job.state === "publishing" || job.state === "awaiting_merge" || job.state === "merged") {
    return {
      ok: true,
      jobId: job.id,
      message: `job already past audit (state=${job.state})`,
      details: { pr_url: job.pr_url },
    };
  }

  if (
    job.state !== "awaiting_audit" &&
    job.state !== "auditing" &&
    job.state !== "reworking"
  ) {
    return {
      ok: false,
      jobId: job.id,
      message: `job state ${job.state} is not ready for audit (need awaiting_audit|auditing|reworking)`,
    };
  }
  if (job.state === "reworking" && job.worktree_path && job.base_sha) {
    const headSha = revParse(job.worktree_path, "HEAD");
    if (!headSha) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: "cannot read rework HEAD for base ancestry",
      });
      return {
        ok: false,
        jobId: job.id,
        message: "cannot read rework HEAD for base ancestry",
      };
    }
    const ancestry = checkAncestor(
      job.worktree_path,
      job.base_sha,
      headSha,
    );
    const error = !ancestry.ok
      ? `cannot verify rework base ancestry: ${ancestry.error}`
      : !ancestry.isAncestor
        ? "rework HEAD is not a descendant of base SHA"
        : null;
    if (error) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: error,
        head_sha: headSha,
      });
      return { ok: false, jobId: job.id, message: error };
    }
  }

  const auditor = getAuditorProfile(config);
  if (auditor.role !== "auditor" || !auditor.readonly) {
    return {
      ok: false,
      message: `auditor profile must be role=auditor readonly=true (got ${auditor.id})`,
    };
  }
  const implementer = getImplementerProfile(config);

  const controller = ensureControllerTerminal(orcaCli, config);
  if (!controller.ok) {
    return { ok: false, jobId: job.id, message: controller.error };
  }
  job = ledger.updateJob(job.id, {
    controller_terminal_handle: controller.handle,
  });

  // Max audit attempts. A retryable reviewer-infrastructure uncertainty consumes
  // an attempt too, so transient failures cannot create an unbounded loop.
  const maxRounds = config.maxAuditRounds;

  while (true) {
    // If reworking, finish implementer first
    if (job.state === "reworking") {
      const rework = runReworkPhase(
        config,
        ledger,
        orcaCli,
        job,
        repo,
        implementer,
        log,
        options,
      );
      if (!rework.ok) return rework;
      job = ledger.getJob(job.id)!;
    }

    // Ensure we are ready to audit
    if (job.state === "awaiting_audit" || job.state === "auditing" || job.state === "reworking") {
      // after rework, state becomes awaiting_audit
    }

    if (job.state !== "awaiting_audit" && job.state !== "auditing") {
      job = ledger.updateJob(job.id, { state: "awaiting_audit" });
    }

    const round =
      job.state === "auditing" && job.audit_round > 0
        ? job.audit_round
        : (job.audit_round ?? 0) + 1;
    if (round > maxRounds) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: `audit rounds exhausted (${maxRounds})`,
      });
      return {
        ok: false,
        jobId: job.id,
        message: `blocked: audit rounds exhausted (${maxRounds})`,
      };
    }

    log(`starting audit round ${round}/${maxRounds}`);
    const audited = runAuditPhase(
      config,
      ledger,
      orcaCli,
      job,
      repo,
      auditor,
      round,
      log,
      options,
    );
    if (!audited.ok && !audited.details?.gateFail) {
      return audited;
    }

    job = ledger.getJob(job.id)!;
    if (job.state === "audit_passed") {
      return {
        ok: true,
        jobId: job.id,
        message: "audit passed; stopped before PR (M3)",
        details: audited.details,
      };
    }

    const gate = audited.details?.gate;
    if (gate?.retryableReviewerInfrastructureFailure && round < maxRounds) {
      job = ledger.updateJob(job.id, {
        // Keep the job in the audit phase, but clear the completed auditor
        // identity so the next iteration must create a fresh independent audit.
        state: "auditing",
        audit_round: round + 1,
        auditor_terminal_handle: null,
        auditor_task_id: null,
        auditor_dispatch_id: null,
        dispatch_attempt: 0,
        dispatch_probe_pending: 0,
        last_error:
          `retrying reviewer infrastructure uncertainty after audit r${round}: ` +
          audited.message,
      });
      setWorktreeProgress(
        orcaCli,
        job.worktree_id!,
        `harness: retrying audit after reviewer infrastructure uncertainty r${round} → r${round + 1}`,
        "in-review",
      );
      log(
        `retrying reviewer infrastructure uncertainty with fresh audit round ${round + 1}/${maxRounds}`,
      );
      continue;
    }
    if (gate?.uncertain) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: audited.message,
      });
      setWorktreeProgress(
        orcaCli,
        job.worktree_id!,
        `harness: blocked after uncertain audit r${round}`,
        "in-review",
      );
      return audited;
    }

    // gate failed
    if (!options.withRework) {
      return {
        ok: false,
        jobId: job.id,
        message: audited.message,
        details: audited.details,
      };
    }

    if (round >= maxRounds) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: `audit failed on final round ${round}: ${audited.message}`,
      });
      setWorktreeProgress(
        orcaCli,
        job.worktree_id!,
        `harness: blocked after audit r${round}`,
        "in-progress",
      );
      return {
        ok: false,
        jobId: job.id,
        message: job.last_error ?? audited.message,
        details: audited.details,
      };
    }

    // enter rework
    job = ledger.updateJob(job.id, {
      state: "reworking",
      last_error: audited.message,
      // clear auditor session for next round
      auditor_terminal_handle: null,
      auditor_task_id: null,
      auditor_dispatch_id: null,
      implementer_task_id: null,
      implementer_dispatch_id: null,
      dispatch_attempt: 0,
      dispatch_probe_pending: 0,
    });
    log(`audit failed; entering rework (next round will be ${round + 1})`);
    // loop continues → rework then audit
  }
}

function runAuditPhase(
  config: RuntimeHarnessConfig,
  ledger: Ledger,
  orcaCli: string,
  job: Job,
  repo: RepoConfig,
  auditor: ReturnType<typeof getAuditorProfile>,
  round: number,
  log: (m: string) => void,
  waitLock: WaitLockOptions,
): AuditOnceResult {
  if (!job.worktree_id || !job.worktree_path || !job.base_sha) {
    return {
      ok: false,
      jobId: job.id,
      message: "job missing worktree/base_sha",
    };
  }
  const worktreeId = job.worktree_id;
  const worktreePath = job.worktree_path;
  const baseSha = job.base_sha;
  const jobChangedWhileWaiting = (): AuditOnceResult => ({
    ok: false,
    jobId: job.id,
    message: "job changed while waiting for audit; retry coordination cycle",
  });
  const updateCurrentJob = (
    patch: Parameters<Ledger["updateJob"]>[1],
  ): Job | null => {
    const updated = ledger.updateJobIf(job.id, job.revision, patch);
    if (updated) job = updated;
    return updated;
  };

  const headSha = revParse(worktreePath, "HEAD");
  if (!headSha) {
    const error = "cannot read HEAD for audit";
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: error,
    });
    return { ok: false, jobId: job.id, message: error };
  }
  if (headSha === baseSha) {
    return {
      ok: false,
      jobId: job.id,
      message: "HEAD equals base_sha; nothing to audit",
    };
  }
  const ancestry = checkAncestor(worktreePath, baseSha, headSha);
  if (!ancestry.ok || !ancestry.isAncestor) {
    const error = ancestry.ok
      ? "audit HEAD is not a descendant of base SHA"
      : `cannot verify audit base ancestry: ${ancestry.error}`;
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: error,
      head_sha: headSha,
    });
    return { ok: false, jobId: job.id, message: error };
  }

  const resultPath = join(worktreePath, ".harness", "audit-result.json");
  mkdirSync(join(worktreePath, ".harness"), { recursive: true });

  // Snapshot tracked cleanliness before audit
  const dirtyBefore = trackedDirty(worktreePath);
  if (dirtyBefore) {
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: `tracked files dirty before audit:\n${dirtyBefore}`,
    });
    return {
      ok: false,
      jobId: job.id,
      message: "tracked files dirty before audit",
      details: { dirtyBefore },
    };
  }

  // Resume only evidence tied to this job's current audit task and round.
  const existing = loadAuditResult(resultPath);
  const sameRoundTask =
    job.state === "auditing" &&
    job.audit_round === round &&
    job.audit_head_sha === headSha &&
    Boolean(job.auditor_task_id);
  const completedSameRoundTask =
    sameRoundTask &&
    orchestrationTaskStatus(
      orcaCli,
      job.auditor_task_id!,
    )?.toLowerCase() === "completed";
  const canReuseResult =
    completedSameRoundTask &&
    existing.ok &&
    Boolean(
      existing.result &&
        auditResultMatchesShas(existing.result, baseSha, headSha),
    );

  if (completedSameRoundTask && !canReuseResult) {
    const error =
      existing.error ??
      "completed audit task produced a result for different base/head SHAs";
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: error,
    });
    return { ok: false, jobId: job.id, message: error };
  }

  if (!canReuseResult) {
    const title = `issue-${job.issue_number}-audit-r${round}`;
    const resumingRound =
      sameRoundTask &&
      Boolean(job.auditor_terminal_handle);
    if (!sameRoundTask) {
      try {
        rmSync(resultPath, { force: true });
      } catch (err) {
        const error = `failed to clear stale audit result: ${(err as Error).message}`;
        job = ledger.updateJob(job.id, {
          state: "blocked",
          last_error: error,
        });
        return { ok: false, jobId: job.id, message: error };
      }
    }
    let handle = resumingRound ? job.auditor_terminal_handle : null;
    if (!handle) {
      log(`creating auditor terminal ${title}`);
      handle = ensureAgentTerminal(orcaCli, worktreeId, auditor, title, {
        forceNew: true,
      });
    } else {
      log(`resuming auditor terminal ${handle} for round ${round}`);
    }
    if (!handle) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: "failed to create auditor terminal",
      });
      return {
        ok: false,
        jobId: job.id,
        message: "failed to create auditor terminal",
      };
    }

    if (!resumingRound) {
      job = ledger.updateJob(job.id, {
        state: "auditing",
        audit_round: round,
        auditor_profile_id: auditor.id,
        auditor_terminal_handle: handle,
        auditor_task_id: null,
        auditor_dispatch_id: null,
        dispatch_attempt: 0,
        dispatch_probe_pending: 0,
        audit_head_sha: headSha,
        head_sha: headSha,
      });
    }
    setWorktreeProgress(
      orcaCli,
      worktreeId,
      `harness: auditing r${round} via ${auditor.id}`,
      "in-review",
    );

    if (!job.auditor_task_id || job.dispatch_probe_pending === 1) {
      const spec = renderAuditorSpec({
        repo: repo.github,
        issueNumber: job.issue_number,
        issueUrl: job.issue_url,
        baseSha,
        headSha,
        branch: job.branch ?? currentBranch(worktreePath) ?? "",
        worktreePath,
        profileId: auditor.id,
        orcaAgent: auditor.orcaAgent,
        invokeHint: auditor.invokeHint,
        auditRound: round,
        resultPath: ".harness/audit-result.json",
      });
      const jobId = job.id;
      const controllerHandle = job.controller_terminal_handle!;
      const existingDispatch =
        job.dispatch_probe_pending === 1 && job.auditor_task_id
          ? {
              taskId: job.auditor_task_id,
              dispatchId: job.auditor_dispatch_id,
              to: handle,
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
        auditRound: number;
        auditHeadSha: string | null;
      } | null = null;
      const auditDispatchFixedPointError = (): string | null => {
        const currentHead = revParse(worktreePath, "HEAD");
        if (currentHead !== headSha) {
          return (
            "audit HEAD changed before dispatch: " +
            `expected ${headSha}, got ${currentHead ?? "unreadable"}`
          );
        }
        const dirty = trackedDirty(worktreePath);
        return dirty ? `tracked files dirty before audit dispatch:\n${dirty}` : null;
      };
      const beforeDispatchWait = (_wait: DispatchWait) => {
        dispatchWaitSnapshot = {
          revision: job.revision,
          state: job.state,
          taskId: job.auditor_task_id,
          dispatchId: job.auditor_dispatch_id,
          terminalHandle: job.auditor_terminal_handle,
          auditRound: job.audit_round,
          auditHeadSha: job.audit_head_sha,
        };
        waitLock.releaseLock();
      };
      const afterDispatchWait = (wait: DispatchWait): string | null => {
        const reacquired = acquireLock(waitLock.lockPath);
        if (!reacquired.ok) {
          dispatchWaitError =
            reacquired.error ?? "failed to reacquire lock after audit dispatch wait";
          return dispatchWaitError;
        }
        const current = ledger.getJob(jobId);
        const expected = dispatchWaitSnapshot;
        if (
          !current ||
          !expected ||
          current.revision !== expected.revision ||
          current.state !== expected.state ||
          current.auditor_task_id !== expected.taskId ||
          current.auditor_dispatch_id !== expected.dispatchId ||
          current.auditor_terminal_handle !== expected.terminalHandle ||
          current.audit_round !== expected.auditRound ||
          current.audit_head_sha !== expected.auditHeadSha
        ) {
          dispatchWaitError =
            "job changed while waiting for audit dispatch; retry coordination cycle";
          return dispatchWaitError;
        }
        job = current;
        if (wait.kind === "terminal_idle") {
          taskCreateGuardError = auditDispatchFixedPointError();
          return taskCreateGuardError;
        }
        return null;
      };
      const ensured = dispatchTaskEnsured(orcaCli, {
        title: `Audit ${repo.github}#${job.issue_number} r${round}`,
        displayName: `issue-${job.issue_number}-audit-r${round}`,
        spec,
        to: handle,
        from: controllerHandle,
        idleTimeoutMs: 120_000,
        onLog: log,
        existingDispatch,
        beforeWait: beforeDispatchWait,
        afterWait: afterDispatchWait,
        beforeTaskCreate: () => {
          taskCreateGuardError = auditDispatchFixedPointError();
          return taskCreateGuardError;
        },
        onDispatched: (event) => {
          job = ledger.updateJob(jobId, {
            state: "auditing",
            auditor_terminal_handle: event.to,
            auditor_task_id: event.taskId,
            auditor_dispatch_id: event.dispatchId,
            dispatch_attempt: event.attempt,
            dispatch_probe_pending: 1,
            last_error: null,
          });
        },
        recreateAgentTerminal: () =>
          ensureAgentTerminal(orcaCli, worktreeId, auditor, title, {
            forceNew: true,
          }),
      });
      if (dispatchWaitError) {
        return { ok: false, jobId, message: dispatchWaitError };
      }
      if (!ensured.ok) {
        const hasLastTask = ensured.lastTaskId !== undefined;
        const taskId = ensured.lastTaskId ?? job.auditor_task_id;
        const dispatchId = hasLastTask
          ? ensured.lastDispatchId ?? null
          : job.auditor_dispatch_id;
        const shouldBlock =
          taskCreateGuardError !== null ||
          ensured.kind === "exhausted" ||
          (hasLastTask && dispatchId === null);
        if (!updateCurrentJob({
          state: shouldBlock ? "blocked" : job.state,
          last_error:
            taskCreateGuardError ?? `dispatch ${ensured.kind}: ${ensured.error}`,
          auditor_terminal_handle: ensured.to,
          auditor_task_id: taskId,
          auditor_dispatch_id: dispatchId,
          dispatch_attempt: hasLastTask
            ? ensured.lastAttempt ?? 0
            : job.dispatch_attempt,
          dispatch_probe_pending:
            shouldBlock || !taskId ? 0 : 1,
        })) {
          return jobChangedWhileWaiting();
        }
        return {
          ok: false,
          jobId: job.id,
          message: taskCreateGuardError ?? ensured.error,
        };
      }

      if (!updateCurrentJob({
        state: "auditing",
        auditor_task_id: ensured.taskId,
        auditor_dispatch_id: ensured.dispatchId,
        auditor_terminal_handle: ensured.to,
        dispatch_attempt: ensured.attempt,
        dispatch_probe_pending: 0,
        last_error: null,
      })) {
        return jobChangedWhileWaiting();
      }
      log(
        `dispatch ok attempt=${ensured.attempt} task=${ensured.taskId} (${ensured.acceptReason})`,
      );
    } else {
      log(`audit task already accepted: ${job.auditor_task_id}`);
    }

    const waitRevision = job.revision;
    const waitTaskId = job.auditor_task_id!;
    const waitDispatchId = job.auditor_dispatch_id;
    waitLock.releaseLock();
    const done = waitWorkerDone(orcaCli, {
      controllerHandle: job.controller_terminal_handle!,
      taskId: waitTaskId,
      dispatchId: waitDispatchId,
      workerHandle: job.auditor_terminal_handle,
      timeoutMs: config.auditTimeoutMinutes * 60_000,
      onTick: (info) => log(info),
      onNoMatchingMessage: () => {
        const late = loadAuditResult(resultPath);
        if (!late.ok || !late.result) return false;
        return (
          orchestrationTaskStatus(orcaCli, waitTaskId)?.toLowerCase() ===
            "completed" &&
          auditResultMatchesShas(late.result, baseSha, headSha)
        );
      },
    });
    const reacquired = acquireLock(waitLock.lockPath);
    if (!reacquired.ok) {
      return {
        ok: false,
        jobId: job.id,
        message: reacquired.error ?? "failed to reacquire lock after audit wait",
      };
    }
    const current = ledger.getJob(job.id);
    if (
      !current ||
      current.revision !== waitRevision ||
      current.state !== "auditing" ||
      current.auditor_task_id !== waitTaskId ||
      current.auditor_dispatch_id !== waitDispatchId ||
      current.audit_round !== round ||
      current.audit_head_sha !== headSha
    ) {
      return jobChangedWhileWaiting();
    }
    job = current;
    if (!done.ok) {
      // worker_done may be lost; completed task provenance is the fallback.
      const late = loadAuditResult(resultPath);
      const completed =
        done.error.startsWith("timeout waiting for worker_done") &&
        orchestrationTaskStatus(
          orcaCli,
          job.auditor_task_id!,
        )?.toLowerCase() === "completed";
      if (
        !(
          completed &&
          late.ok &&
          late.result &&
          auditResultMatchesShas(late.result, baseSha, headSha)
        )
      ) {
        if (!updateCurrentJob({
          state: "blocked",
          last_error: done.error,
          intervention_json: done.intervention
            ? JSON.stringify({
                ...done.intervention,
                sourceState: "auditing",
                role: "auditor",
                headSha,
              })
            : null,
          intervention_resolved_at: null,
        })) {
          return jobChangedWhileWaiting();
        }
        return { ok: false, jobId: job.id, message: done.error };
      }
      log(
        "worker_done missing but same-round task completed with a valid result; continuing",
      );
    } else if (done.recovered) {
      log(
        "worker_done missing but same-round task completed with a valid result; continuing",
      );
    } else {
      log("received auditor worker_done");
    }
  } else {
    log(
      "M5 resume: reusing valid audit result from the completed same-round task",
    );
    if (!updateCurrentJob({
      state: "auditing",
      audit_round: round,
      audit_head_sha: headSha,
      head_sha: headSha,
      dispatch_attempt: 0,
      dispatch_probe_pending: 0,
    })) {
      return jobChangedWhileWaiting();
    }
  }

  // Cleanliness: tracked files must not change
  const dirtyAfter = trackedDirty(worktreePath);
  if (dirtyAfter) {
    if (!updateCurrentJob({
      state: "blocked",
      last_error: `auditor modified tracked files:\n${dirtyAfter}`,
    })) {
      return jobChangedWhileWaiting();
    }
    return {
      ok: false,
      jobId: job.id,
      message: "auditor modified tracked files",
      details: { dirtyAfter },
    };
  }

  // HEAD must be unchanged during audit
  const headAfter = revParse(worktreePath, "HEAD");
  if (!headAfter || headAfter !== headSha) {
    if (!updateCurrentJob({
      state: "blocked",
      last_error: `HEAD changed during audit: ${headSha} → ${headAfter}`,
    })) {
      return jobChangedWhileWaiting();
    }
    return {
      ok: false,
      jobId: job.id,
      message: "HEAD changed during audit",
    };
  }

  const loaded = loadAuditResult(resultPath);
  const gate = evaluateAuditGate(loaded.result ?? null, {
    expectedBaseSha: baseSha,
    expectedHeadSha: headSha,
    parseError: loaded.error,
  });

  // Persist result
  const resultJson = loaded.result
    ? JSON.stringify(loaded.result, null, 2)
    : JSON.stringify({ error: loaded.error });
  if (!updateCurrentJob({ audit_result_json: resultJson })) {
    return jobChangedWhileWaiting();
  }
  // also archive round copy
  try {
    writeFileSync(
      join(worktreePath, ".harness", `audit-result.r${round}.json`),
      resultJson,
    );
  } catch {
    // best-effort
  }

  if (gate.pass) {
    if (!updateCurrentJob({
      state: "audit_passed",
      dispatch_attempt: 0,
      dispatch_probe_pending: 0,
      last_error: null,
      intervention_json: null,
      intervention_resolved_at: null,
    })) {
      return jobChangedWhileWaiting();
    }
    setWorktreeProgress(
      orcaCli,
      worktreeId,
      `harness: audit_passed r${round} (M3 stop, no PR)`,
      "in-review",
    );
    return {
      ok: true,
      jobId: job.id,
      message: gate.reason,
      details: {
        round,
        gate,
        headSha,
        commits: logOnelineSince(worktreePath, baseSha),
      },
    };
  }

  // Keep the same round recoverable until the caller moves it to rework.
  if (!updateCurrentJob({
    state: "auditing",
    dispatch_attempt: 0,
    dispatch_probe_pending: 0,
    last_error: gate.reason,
  })) {
    return jobChangedWhileWaiting();
  }
  setWorktreeProgress(
    orcaCli,
    worktreeId,
    `harness: audit fail r${round} — ${gate.reason}`.slice(0, 180),
    "in-review",
  );
  return {
    ok: false,
    jobId: job.id,
    message: gate.reason,
    details: { round, gate, gateFail: true, headSha },
  };
}

function runReworkPhase(
  config: RuntimeHarnessConfig,
  ledger: Ledger,
  orcaCli: string,
  job: Job,
  repo: RepoConfig,
  implementer: ReturnType<typeof getImplementerProfile>,
  log: (m: string) => void,
  waitLock: WaitLockOptions,
): AuditOnceResult {
  if (!job.worktree_id || !job.worktree_path || !job.base_sha) {
    return { ok: false, jobId: job.id, message: "missing worktree for rework" };
  }
  const worktreeId = job.worktree_id;
  const worktreePath = job.worktree_path;
  const baseSha = job.base_sha;
  const jobChangedWhileWaiting = (): AuditOnceResult => ({
    ok: false,
    jobId: job.id,
    message: "job changed while waiting for rework; retry coordination cycle",
  });
  const updateCurrentJob = (
    patch: Parameters<Ledger["updateJob"]>[1],
  ): Job | null => {
    const updated = ledger.updateJobIf(job.id, job.revision, patch);
    if (updated) job = updated;
    return updated;
  };
  const blockRework = (
    error: string,
    intervention?: NonNullable<
      Extract<ReturnType<typeof waitWorkerDone>, { ok: false }>["intervention"]
    >,
  ): AuditOnceResult => {
    if (!updateCurrentJob({
      state: "blocked",
      last_error: error,
      intervention_json: intervention
        ? JSON.stringify({
            ...intervention,
            sourceState: "reworking",
            role: "implementer",
            headSha: revParse(worktreePath, "HEAD"),
          })
        : null,
      intervention_resolved_at: null,
    })) {
      return jobChangedWhileWaiting();
    }
    return { ok: false, jobId: job.id, message: error };
  };
  const blockFailedTask = (taskId: string): AuditOnceResult =>
    blockRework(
      `rework task ${taskId} is not completed (Orca status=failed)`,
    );
  const auditHeadSha = job.audit_head_sha;
  if (!auditHeadSha) {
    return blockRework("rework missing audited HEAD");
  }
  const inspectReworkCompletion = ():
    | { ok: true; headSha: string; commits: number }
    | { ok: false; error: string } => {
    const headSha = revParse(worktreePath, "HEAD");
    if (!headSha) {
      return { ok: false, error: "cannot read rework HEAD" };
    }
    if (headSha === auditHeadSha) {
      return {
        ok: false,
        error: REWORK_NO_COMMITS_AFTER_AUDITED_HEAD_ERROR,
      };
    }
    const ancestry = checkAncestor(
      worktreePath,
      auditHeadSha,
      headSha,
    );
    if (!ancestry.ok) {
      return {
        ok: false,
        error: `cannot verify rework ancestry: ${ancestry.error}`,
      };
    }
    if (!ancestry.isAncestor) {
      return {
        ok: false,
        error: "rework HEAD is not a descendant of audited HEAD",
      };
    }
    const count = git(worktreePath, [
      "rev-list",
      "--count",
      `${auditHeadSha}..${headSha}`,
    ]);
    if (!count.ok) {
      return {
        ok: false,
        error:
          `cannot count rework commits: ` +
          `${count.stderr || "unknown Git error"}`,
      };
    }
    const commits = Number(count.stdout);
    if (!Number.isSafeInteger(commits)) {
      return {
        ok: false,
        error: `invalid rework commit count: ${count.stdout}`,
      };
    }
    if (commits < 1) {
      return {
        ok: false,
        error: "rework produced zero commits after audited HEAD",
      };
    }
    const dirty = trackedDirty(worktreePath);
    if (dirty) {
      return {
        ok: false,
        error: `tracked files dirty after rework:\n${dirty}`,
      };
    }
    return { ok: true, headSha, commits };
  };
  const finishRework = (
    completion: { headSha: string; commits: number },
  ): AuditOnceResult => {
    if (!updateCurrentJob({
      state: "awaiting_audit",
      head_sha: completion.headSha,
      last_error: null,
      intervention_json: null,
      intervention_resolved_at: null,
      // force new audit task next
      auditor_task_id: null,
      auditor_dispatch_id: null,
      auditor_terminal_handle: null,
      dispatch_attempt: 0,
      dispatch_probe_pending: 0,
    })) {
      return jobChangedWhileWaiting();
    }
    log(
      `rework done head=${completion.headSha.slice(0, 7)} ` +
      `commits_since_audit=${completion.commits}`,
    );
    return {
      ok: true,
      jobId: job.id,
      message: "rework complete; ready for re-audit",
      details: completion,
    };
  };
  let failedPendingTaskId: string | null = null;
  if (job.implementer_task_id) {
    const taskStatus =
      orchestrationTaskStatus(
        orcaCli,
        job.implementer_task_id,
      )?.toLowerCase() ?? "unavailable";
    const canRetryFailedAcceptance =
      taskStatus === "failed" &&
      job.dispatch_probe_pending === 1 &&
      revParse(worktreePath, "HEAD") === auditHeadSha;
    failedPendingTaskId = canRetryFailedAcceptance
      ? job.implementer_task_id
      : null;
    if (
      taskStatus === "failed" &&
      !canRetryFailedAcceptance
    ) {
      return blockFailedTask(job.implementer_task_id);
    }
    const recovered = inspectReworkCompletion();
    if (recovered.ok) {
      if (taskStatus === "completed") {
        log(
          "M5 resume: completed rework task has commits; " +
          "skipping worker_done wait",
        );
        return finishRework(recovered);
      }
      log(
        `committed rework exists but task status=${taskStatus}; ` +
        "waiting for worker_done",
      );
    }
  }
  const dispatchFixedPointError = (): string | null => {
    const reworkStartHead = revParse(worktreePath, "HEAD");
    if (reworkStartHead !== auditHeadSha) {
      return (
        `rework HEAD changed before rework dispatch: expected ${auditHeadSha}, ` +
        `got ${reworkStartHead ?? "unreadable"}`
      );
    }
    const dirtyBeforeRework = trackedDirty(worktreePath);
    if (dirtyBeforeRework) {
      return `tracked files dirty before rework dispatch:\n${dirtyBeforeRework}`;
    }
    return null;
  };
  if (!job.implementer_task_id) {
    const fixedPointError = dispatchFixedPointError();
    if (fixedPointError) return blockRework(fixedPointError);
  }

  const needsDispatch =
    !job.implementer_task_id || job.dispatch_probe_pending === 1;
  let handle = job.implementer_terminal_handle;
  if (needsDispatch) {
    handle = ensureAgentTerminal(
      orcaCli,
      worktreeId,
      implementer,
      `issue-${job.issue_number}-${implementer.orcaAgent}`,
    );
    if (handle && handle !== job.implementer_terminal_handle) {
      job = ledger.updateJob(job.id, {
        implementer_terminal_handle: handle,
      });
    }
  }
  if (needsDispatch) {
    if (!handle) {
      return {
        ok: false,
        jobId: job.id,
        message: "no implementer terminal for rework",
      };
    }
    const dispatchHandle = handle;
    const auditJson = job.audit_result_json ?? "{}";
    const spec = renderReworkSpec({
      repo: repo.github,
      issueNumber: job.issue_number,
      issueUrl: job.issue_url,
      baseSha,
      branch: job.branch ?? "",
      worktreePath,
      profileId: implementer.id,
      invokeHint: implementer.invokeHint,
      auditRound: job.audit_round,
      auditResultJson: auditJson,
    });
    const jobId = job.id;
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
      auditRound: number;
      auditHeadSha: string | null;
    } | null = null;
    const beforeDispatchWait = (_wait: DispatchWait) => {
      dispatchWaitSnapshot = {
        revision: job.revision,
        state: job.state,
        taskId: job.implementer_task_id,
        dispatchId: job.implementer_dispatch_id,
        terminalHandle: job.implementer_terminal_handle,
        auditRound: job.audit_round,
        auditHeadSha: job.audit_head_sha,
      };
      waitLock.releaseLock();
    };
    const afterDispatchWait = (wait: DispatchWait): string | null => {
      const reacquired = acquireLock(waitLock.lockPath);
      if (!reacquired.ok) {
        dispatchWaitError =
          reacquired.error ?? "failed to reacquire lock after rework dispatch wait";
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
        current.implementer_terminal_handle !== expected.terminalHandle ||
        current.audit_round !== expected.auditRound ||
        current.audit_head_sha !== expected.auditHeadSha
      ) {
        dispatchWaitError =
          "job changed while waiting for rework dispatch; retry coordination cycle";
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
      title: `Rework ${repo.github}#${job.issue_number} after audit r${job.audit_round}`,
      displayName: `issue-${job.issue_number}-rework-r${job.audit_round}`,
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
          state: "reworking",
          implementer_terminal_handle: event.to,
          implementer_task_id: event.taskId,
          implementer_dispatch_id: event.dispatchId,
          dispatch_attempt: event.attempt,
          dispatch_probe_pending: 1,
          last_error: null,
        });
      },
      recreateAgentTerminal: () => {
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
      return { ok: false, jobId, message: dispatchWaitError };
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
        (hasLastTask && dispatchId === null);
      if (!updateCurrentJob({
        state: shouldBlock ? "blocked" : "reworking",
        last_error:
          taskCreateGuardError ??
          `dispatch ${ensured.kind}: ${ensured.error}`,
        implementer_terminal_handle: ensured.to,
        implementer_task_id: taskId,
        implementer_dispatch_id: dispatchId,
        dispatch_attempt: hasLastTask
          ? ensured.lastAttempt ?? 0
          : job.dispatch_attempt,
        dispatch_probe_pending:
          shouldBlock || !taskId ? 0 : 1,
      })) {
        return jobChangedWhileWaiting();
      }
      return {
        ok: false,
        jobId: job.id,
        message: taskCreateGuardError ?? ensured.error,
      };
    }

    if (!updateCurrentJob({
      state: "reworking",
      implementer_terminal_handle: ensured.to,
      implementer_task_id: ensured.taskId,
      implementer_dispatch_id: ensured.dispatchId,
      dispatch_attempt: ensured.attempt,
      dispatch_probe_pending: 0,
      last_error: null,
    })) {
      return jobChangedWhileWaiting();
    }
    if (ensured.taskId === failedPendingTaskId) {
      return blockFailedTask(ensured.taskId);
    }
    log(
      `dispatch ok attempt=${ensured.attempt} rework task=${ensured.taskId}`,
    );
  } else {
    log(`rework task already accepted: ${job.implementer_task_id}`);
  }

  setWorktreeProgress(
    orcaCli,
    worktreeId,
    `harness: reworking after audit r${job.audit_round}`,
    "in-progress",
  );
  const waitRevision = job.revision;
  const waitTaskId = job.implementer_task_id!;
  const waitDispatchId = job.implementer_dispatch_id;
  waitLock.releaseLock();
  const done = waitWorkerDone(orcaCli, {
    controllerHandle: job.controller_terminal_handle!,
    taskId: waitTaskId,
    dispatchId: waitDispatchId,
    workerHandle: job.implementer_terminal_handle,
    timeoutMs: config.implementTimeoutMinutes * 60_000,
    onTick: (info) => log(info),
  });
  const reacquired = acquireLock(waitLock.lockPath);
  if (!reacquired.ok) {
    return {
      ok: false,
      jobId: job.id,
      message: reacquired.error ?? "failed to reacquire lock after rework wait",
    };
  }
  const current = ledger.getJob(job.id);
  if (
    !current ||
    current.revision !== waitRevision ||
    current.state !== "reworking" ||
    current.implementer_task_id !== waitTaskId ||
    current.implementer_dispatch_id !== waitDispatchId
  ) {
    return jobChangedWhileWaiting();
  }
  job = current;
  if (!done.ok) {
    if (done.escalated) {
      return blockRework(done.error, done.intervention);
    }
    if (done.intervention) {
      return blockRework(done.error, done.intervention);
    }
    const recovered = inspectReworkCompletion();
    if (recovered.ok) {
      const taskStatus =
        orchestrationTaskStatus(
          orcaCli,
          job.implementer_task_id!,
        )?.toLowerCase() ?? "unavailable";
      if (taskStatus !== "completed") {
        return blockRework(
          `rework task ${job.implementer_task_id} is not completed ` +
            `(Orca status=${taskStatus})`,
        );
      }
      log(
        "worker_done missing but completed rework task has commits; " +
          "continuing re-audit (M5)",
      );
      return finishRework(recovered);
    }
    return blockRework(`${done.error}; ${recovered.error}`);
  }

  if (
    orchestrationTaskStatus(
      orcaCli,
      job.implementer_task_id!,
    )?.toLowerCase() === "failed"
  ) {
    return blockFailedTask(job.implementer_task_id!);
  }
  const completion = inspectReworkCompletion();
  return completion.ok
    ? finishRework(completion)
    : blockRework(completion.error);
}
