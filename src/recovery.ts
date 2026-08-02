import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  inspectAuditArtifact,
  trackedDirty,
} from "./audit-gate.js";
import { defaultLedgerPath, defaultLockPath } from "./config.js";
import { checkAncestor, commitCountSince, revParse } from "./git.js";
import { execFile } from "./exec.js";
import {
  findPrByHead,
  viewIssue,
  viewPullRequest,
} from "./github.js";
import { Ledger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import { orcaJson, requireOrcaCli, unwrapResult } from "./orca.js";
import { loadRuntimeConfig, validateProjectRuntime } from "./project.js";
import {
  classifyRecoverExecution,
  isTimedOutReworkWithoutNewCommit,
  isExhaustedAuditProviderError,
  isExhaustedReworkProviderError,
  isAuditHeadChangedError,
  isStaleReworkTaskStatusError,
  reconcileJob,
  REWORK_NO_COMMITS_AFTER_AUDITED_HEAD_ERROR,
  type RecoverAction,
  type ReconcileHints,
} from "./reconcile.js";
import { runOnce } from "./run-once.js";
import { auditOnce } from "./audit-once.js";
import { publishOnce } from "./publisher.js";
import { waitMerge } from "./merge-monitor.js";
import type {
  Job,
  JobState,
  RepoConfig,
  RuntimeHarnessConfig,
} from "./types.js";
import { parseWorkerIntervention } from "./intervention.js";

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
export function runRecoveryCycle(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  dryRun?: boolean;
  mode?: "automatic" | "explicit_recovery";
  /** When executing wait_merge, only poll once by default. */
  waitMergeTimeoutMinutes?: number;
  acknowledgeEscalation?: boolean;
  decisionReply?: string;
}): RecoverResult {
  const config = loadRuntimeConfig(options.configPath);
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
    let job = ledger.getActiveJob();
    const project = job
      ? ledger.resolveJobProject(
          job.id,
          config.repositories,
          options.dryRun ? "read_only" : "persist_legacy",
        )
      : null;
    if (project?.ok) job = project.job;
    let projectError = project && !project.ok ? project.error : null;
    if (project?.ok) {
      try {
        const runtime = validateProjectRuntime(
          project.project,
          requireOrcaCli(config),
        );
        if (!runtime.ok) projectError = runtime.error;
      } catch (err) {
        projectError = `cannot verify project runtime: ${(err as Error).message}`;
      }
    }
    const hints = projectError
      ? {}
      : gatherHints(config, job, project?.ok ? project.project : null);
    const action = projectError
      ? { kind: "blocked" as const, reason: projectError, persist: true }
      : reconcileJob(job, hints);

    const base: RecoverResult = {
      ok: true,
      message: action.reason,
      action,
      jobId: job?.id,
      details: {
        state: job?.state ?? null,
        repo: job ? `${job.repo}#${job.issue_number}` : null,
        hints,
        intervention: job ? parseWorkerIntervention(job) : null,
      },
      executed: false,
    };

    if (
      !options.dryRun &&
      options.mode === "automatic" &&
      classifyRecoverExecution(action, job?.state) === "explicit_recovery"
    ) {
      return base;
    }

    if (options.dryRun || action.kind === "noop" || action.kind === "none") {
      return base;
    }
    if (action.kind === "resolve_intervention") {
      if (!job || !project?.ok) {
        return {
          ...base,
          ok: false,
          message: "cannot resolve intervention without an active job and valid project",
        };
      }
      return resolveWorkerIntervention({
        action,
        job,
        hints,
        ledger,
        config,
        acknowledgeEscalation: options.acknowledgeEscalation,
        decisionReply: options.decisionReply,
        base,
      });
    }
    if (action.kind === "blocked") {
      if (action.persist && job) {
        const blocked = ledger.updateJob(job.id, {
          state: "blocked",
          last_error: action.reason,
        });
        return {
          ...base,
          ok: false,
          message: action.reason,
          details: { ...base.details, state: blocked.state },
          executed: true,
        };
      }
      return { ...base, ok: false, message: action.reason };
    }
    if (job?.state === "blocked" && action.kind === "publish_once") {
      job = ledger.updateJob(job.id, {
        state: "audit_passed",
      });
    }
    if (job?.state === "blocked" && action.kind === "audit_once") {
      const head = job.worktree_path
        ? revParse(job.worktree_path, "HEAD")
        : null;
      let recoveryError: string | null = null;
      if (!job.worktree_path || !job.base_sha || !head) {
        recoveryError =
          "cannot verify blocked audit recovery ancestry: unreadable worktree, base, or HEAD";
      } else {
        const ancestry = checkAncestor(
          job.worktree_path,
          job.base_sha,
          head,
        );
        recoveryError = !ancestry.ok
          ? `cannot verify blocked audit recovery ancestry: ${ancestry.error}`
          : !ancestry.isAncestor
            ? "blocked audit recovery HEAD is not a descendant of base SHA"
            : null;
      }
      if (
        !recoveryError &&
        (action.recovery === "retry_malformed_result" ||
          action.recovery === "retry_stale_result" ||
          action.recovery === "retry_snapshot_mismatch") &&
        job.worktree_path &&
        job.base_sha &&
        head
      ) {
        const expectedArtifactStatus =
          action.recovery === "retry_malformed_result"
            ? "malformed"
            : action.recovery === "retry_snapshot_mismatch"
              ? "current"
              : "stale";
        if (!job.auditor_task_id) {
          recoveryError =
            `cannot recover ${expectedArtifactStatus} audit without the completed auditor task`;
        } else if (hints.auditTaskStatus?.toLowerCase() !== "completed") {
          recoveryError =
            `cannot recover ${expectedArtifactStatus} audit before the auditor task completes`;
        } else if (job.audit_round <= 0) {
          recoveryError =
            `cannot recover ${expectedArtifactStatus} audit without audit-round provenance`;
        } else if (
          action.recovery === "retry_malformed_result" &&
          job.audit_head_sha !== head
        ) {
          recoveryError =
            "cannot recover malformed audit without same-round HEAD provenance";
        } else if (
          action.recovery === "retry_stale_result" &&
          job.audit_head_sha === head
        ) {
          recoveryError =
            "cannot recover stale audit without a newer committed HEAD";
        } else if (
          action.recovery === "retry_snapshot_mismatch" &&
          (job.audit_head_sha === head ||
            job.head_sha !== job.audit_head_sha ||
            !isAuditHeadChangedError(job.last_error))
        ) {
          recoveryError =
            "cannot recover audit snapshot mismatch without changed-HEAD provenance";
        } else {
          const artifact = inspectAuditArtifact(
            join(job.worktree_path, ".harness", "audit-result.json"),
            job.base_sha,
            head,
          );
          const dirty = trackedDirty(job.worktree_path);
          if (dirty) {
            recoveryError =
              `cannot recover ${expectedArtifactStatus} audit with tracked changes:\n${dirty}`;
          } else if (
            action.recovery === "retry_snapshot_mismatch"
              ? artifact.status !== "current" ||
                artifact.result.status !== "uncertain" ||
                artifact.result.uncertain_reason !== "snapshot_mismatch"
              : artifact.status !== expectedArtifactStatus
          ) {
            recoveryError =
              `cannot recover ${expectedArtifactStatus} audit after artifact changed to ${artifact.status}`;
          }
        }
      }
      if (
        !recoveryError &&
        action.recovery === "retry_exhausted_provider" &&
        job.worktree_path &&
        job.base_sha &&
        head
      ) {
        if (!job.auditor_task_id || job.audit_round <= 0) {
          recoveryError =
            "cannot retry exhausted audit provider without auditor and audit-round provenance";
        } else if (!isExhaustedAuditProviderError(job.last_error)) {
          recoveryError =
            "exhausted audit provider recovery requires the exact provider retry error";
        } else if (!['dispatched', 'failed'].includes(hints.auditTaskStatus?.toLowerCase() ?? '')) {
          recoveryError =
            "cannot retry exhausted audit provider before the failed auditor is confirmed inactive";
        } else if (job.audit_head_sha !== head || job.head_sha !== head) {
          recoveryError =
            "exhausted audit provider recovery requires same-HEAD audit provenance";
        } else if (hints.trackedClean !== true) {
          recoveryError =
            "cannot retry exhausted audit provider with tracked changes";
        } else {
          const artifact = inspectAuditArtifact(
            join(job.worktree_path, ".harness", "audit-result.json"),
            job.base_sha,
            head,
          );
          if (artifact.status !== "missing") {
            recoveryError =
              `cannot retry exhausted audit provider after audit artifact changed to ${artifact.status}`;
          }
        }
      }
      if (
        !recoveryError &&
        action.recovery === "resume_completed_rework" &&
        job.worktree_path &&
        head
      ) {
        if (!job.implementer_task_id || !job.audit_head_sha) {
          recoveryError = "cannot resume completed rework without task and audited-HEAD provenance";
        } else if (!isStaleReworkTaskStatusError(job.last_error)) {
          recoveryError = "completed rework recovery requires the stale dispatched-task error";
        } else if (hints.implementTaskStatus?.toLowerCase() !== "completed") {
          recoveryError = "cannot resume completed rework before the task is confirmed completed";
        } else if (head === job.audit_head_sha) {
          recoveryError = "completed rework recovery requires a commit after the audited HEAD";
        } else if (hints.trackedClean !== true) {
          recoveryError = "completed rework recovery requires a clean worktree";
        } else {
          const ancestry = checkAncestor(job.worktree_path, job.audit_head_sha, head);
          if (!ancestry.ok || !ancestry.isAncestor) {
            recoveryError = ancestry.ok
              ? "completed rework HEAD is not a descendant of the audited HEAD"
              : `cannot verify completed rework ancestry: ${ancestry.error}`;
          }
        }
      }
      if (
        !recoveryError &&
        action.recovery === "retry_validation_only_rework" &&
        job.worktree_path &&
        job.base_sha &&
        head
      ) {
        if (!job.implementer_task_id) {
          recoveryError =
            "cannot re-audit validation-only rework without the completed rework task";
        } else if (hints.implementTaskStatus?.toLowerCase() !== "completed") {
          recoveryError =
            "cannot re-audit validation-only rework before the rework task completes";
        } else if (
          job.last_error !== REWORK_NO_COMMITS_AFTER_AUDITED_HEAD_ERROR ||
          job.audit_round <= 0 ||
          job.audit_head_sha !== head ||
          job.head_sha !== head
        ) {
          recoveryError =
            "cannot re-audit validation-only rework without same-HEAD provenance";
        } else {
          const artifact = inspectAuditArtifact(
            join(job.worktree_path, ".harness", "audit-result.json"),
            job.base_sha,
            head,
          );
          const dirty = trackedDirty(job.worktree_path);
          if (dirty) {
            recoveryError =
              `cannot re-audit validation-only rework with tracked changes:\n${dirty}`;
          } else if (artifact.status !== "current") {
            recoveryError =
              `cannot re-audit validation-only rework after artifact changed to ${artifact.status}`;
          }
        }
      }
      if (!recoveryError && action.recovery === "retry_stuck_rework") {
        if (!job.worktree_path || !job.base_sha || !head) {
          recoveryError =
            "cannot retry timed-out rework without a readable worktree, base, and HEAD";
        } else if (!job.implementer_task_id || !job.implementer_dispatch_id) {
          recoveryError =
            "cannot retry timed-out rework without the failed task and dispatch identity";
        } else if (hints.implementTaskStatus?.toLowerCase() !== "failed") {
          recoveryError =
            "cannot retry timed-out rework before the stale task is confirmed failed";
        } else if (
          !isTimedOutReworkWithoutNewCommit(job) ||
          job.audit_head_sha !== head ||
          job.head_sha !== head
        ) {
          recoveryError =
            "cannot retry timed-out rework without same-audited-HEAD provenance";
        } else {
          const artifact = inspectAuditArtifact(
            join(job.worktree_path, ".harness", "audit-result.json"),
            job.base_sha,
            head,
          );
          const dirty = trackedDirty(job.worktree_path);
          if (dirty) {
            recoveryError = `cannot retry timed-out rework with tracked changes:\n${dirty}`;
          } else if (artifact.status !== "current") {
            recoveryError =
              `cannot retry timed-out rework after audit artifact changed to ${artifact.status}`;
          }
        }
      }
      if (
        !recoveryError &&
        action.recovery === "retry_exhausted_rework_provider"
      ) {
        if (!job.worktree_path || !job.base_sha || !head) {
          recoveryError =
            "cannot retry exhausted rework provider without a readable worktree, base, and HEAD";
        } else if (!job.implementer_task_id || !job.implementer_dispatch_id) {
          recoveryError =
            "cannot retry exhausted rework provider without the failed task and dispatch identity";
        } else if (hints.implementTaskStatus?.toLowerCase() !== "failed") {
          recoveryError =
            "cannot retry exhausted rework provider before the stale task is confirmed failed";
        } else if (
          !isExhaustedReworkProviderError(job.last_error) ||
          job.audit_round <= 0 ||
          job.audit_head_sha !== head ||
          job.head_sha !== head
        ) {
          recoveryError =
            "cannot retry exhausted rework provider without same-audited-HEAD provenance";
        } else {
          const artifact = inspectAuditArtifact(
            join(job.worktree_path, ".harness", "audit-result.json"),
            job.base_sha,
            head,
          );
          const dirty = trackedDirty(job.worktree_path);
          if (dirty) {
            recoveryError =
              `cannot retry exhausted rework provider with tracked changes:\n${dirty}`;
          } else if (artifact.status !== "current") {
            recoveryError =
              `cannot retry exhausted rework provider after audit artifact changed to ${artifact.status}`;
          }
        }
      }
      if (recoveryError) {
        ledger.updateJob(job.id, {
          state: "blocked",
          last_error: recoveryError,
        });
        return {
          ...base,
          ok: false,
          message: recoveryError,
        };
      }
      if (
        action.recovery === "retry_stuck_rework" ||
        action.recovery === "retry_exhausted_rework_provider"
      ) {
        // Preserve the audited artifact/result for the rework prompt, but forget
        // the terminal task identity so auditOnce can create a new rework task.
        ledger.updateJob(job.id, {
          state: "reworking",
          implementer_terminal_handle: null,
          implementer_task_id: null,
          implementer_dispatch_id: null,
          dispatch_attempt: 0,
          dispatch_probe_pending: 0,
          last_error: null,
          head_sha: head,
        });
      } else if (
        action.recovery === "retry_malformed_result" ||
        action.recovery === "retry_validation_only_rework" ||
        action.recovery === "retry_stale_result" ||
        action.recovery === "resume_completed_rework" ||
        action.recovery === "retry_exhausted_provider" ||
        action.recovery === "retry_snapshot_mismatch"
      ) {
        ledger.updateJob(job.id, {
          state:
            action.recovery === "retry_validation_only_rework" ||
            action.recovery === "resume_completed_rework"
              ? "awaiting_audit"
              : "auditing",
          auditor_terminal_handle: null,
          auditor_task_id: null,
          auditor_dispatch_id: null,
          dispatch_attempt: 0,
          dispatch_probe_pending: 0,
          audit_result_json: null,
          last_error: null,
          head_sha: head,
        });
        try {
          rmSync(
            join(job.worktree_path!, ".harness", "audit-result.json"),
            { force: true },
          );
        } catch (err) {
          const error = `failed to clear audit result: ${(err as Error).message}`;
          ledger.updateJob(job.id, {
            state: "blocked",
            last_error: error,
          });
          return { ...base, ok: false, message: error };
        }
      } else {
        ledger.updateJob(job.id, {
          state: "auditing",
          last_error: null,
        });
      }
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
      implementerTaskId: job?.implementer_task_id,
      implementerDispatchId: job?.implementer_dispatch_id,
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

export function resolveWorkerIntervention(input: {
  action: Extract<RecoverAction, { kind: "resolve_intervention" }>;
  job: Job;
  hints: ReconcileHints;
  ledger: Ledger;
  config: RuntimeHarnessConfig;
  acknowledgeEscalation?: boolean;
  decisionReply?: string;
  base: RecoverResult;
}): RecoverResult {
  const intervention = parseWorkerIntervention(input.job);
  if (!intervention) {
    return { ...input.base, ok: false, message: "stored intervention is malformed" };
  }
  if (intervention.kind !== input.action.intervention) {
    return {
      ...input.base,
      ok: false,
      message: "intervention changed after recovery planning; re-run dry-run",
    };
  }
  const expectedTask =
    intervention.role === "auditor"
      ? input.job.auditor_task_id
      : input.job.implementer_task_id;
  const expectedDispatch =
    intervention.role === "auditor"
      ? input.job.auditor_dispatch_id
      : input.job.implementer_dispatch_id;
  if (
    intervention.taskId !== expectedTask ||
    intervention.dispatchId !== expectedDispatch
  ) {
    return {
      ...input.base,
      ok: false,
      message: "stored intervention no longer matches the active task and dispatch",
    };
  }
  if (
    !input.hints.worktreeExists ||
    !input.hints.currentHeadSha ||
    input.hints.baseIsAncestor !== true ||
    input.hints.trackedClean !== true
  ) {
    return {
      ...input.base,
      ok: false,
      message:
        "intervention recovery requires an existing clean worktree with verified base ancestry",
    };
  }
  if (intervention.headSha !== input.hints.currentHeadSha) {
    return {
      ...input.base,
      ok: false,
      message:
        `worktree HEAD changed after intervention: expected ` +
        `${intervention.headSha ?? "unreadable"}, got ${input.hints.currentHeadSha}`,
    };
  }

  if (intervention.kind === "escalation") {
    if (!input.acknowledgeEscalation) {
      return {
        ...input.base,
        ok: false,
        message:
          "escalation not acknowledged; use --acknowledge-escalation with --execute after review",
      };
    }
    const status =
      intervention.role === "auditor"
        ? input.hints.auditTaskStatus
        : input.hints.implementTaskStatus;
    if (status?.toLowerCase() !== "completed") {
      return {
        ...input.base,
        ok: false,
        message: `escalated task is not completed (Orca status=${status ?? "unavailable"})`,
      };
    }
  } else {
    const reply = input.decisionReply?.trim();
    if (!reply) {
      return {
        ...input.base,
        ok: false,
        message:
          "decision gate has no human reply; use --reply <text> with --execute",
      };
    }
    if (!intervention.messageId) {
      return {
        ...input.base,
        ok: false,
        message: "decision gate has no message id and cannot be replied to safely",
      };
    }
    if (!input.job.controller_terminal_handle) {
      return {
        ...input.base,
        ok: false,
        message: "decision gate has no controller terminal provenance",
      };
    }
    const orcaCli = requireOrcaCli(input.config);
    const replied = orcaJson(orcaCli, [
      "orchestration",
      "reply",
      "--id",
      intervention.messageId,
      "--body",
      reply,
      "--from",
      input.job.controller_terminal_handle,
    ]);
    if (!replied.ok) {
      return {
        ...input.base,
        ok: false,
        message: `decision gate reply failed: ${replied.error ?? "unknown Orca error"}`,
      };
    }
  }

  let nextState: JobState = intervention.sourceState;
  if (intervention.kind === "escalation") {
    if (intervention.sourceState === "implementing") {
      if (input.hints.hasCommitsSinceBase !== true) {
        return {
          ...input.base,
          ok: false,
          message: "completed implementation escalation has no commit since base",
        };
      }
      nextState = "awaiting_audit";
    } else if (intervention.sourceState === "reworking") {
      if (!input.job.audit_head_sha) {
        return {
          ...input.base,
          ok: false,
          message: "completed rework escalation has no audited HEAD provenance",
        };
      }
      const ancestry = checkAncestor(
        input.job.worktree_path!,
        input.job.audit_head_sha,
        input.hints.currentHeadSha,
      );
      if (!ancestry.ok || !ancestry.isAncestor) {
        return {
          ...input.base,
          ok: false,
          message: ancestry.ok
            ? "rework HEAD is not a descendant of the audited HEAD"
            : `cannot verify rework ancestry: ${ancestry.error}`,
        };
      }
      if (
        input.hints.currentHeadSha === input.job.audit_head_sha &&
        (input.hints.auditArtifactStatus !== "current" ||
          input.hints.auditResultReady !== true)
      ) {
        return {
          ...input.base,
          ok: false,
          message:
            "same-HEAD rework escalation lacks the current audited artifact",
        };
      }
      nextState = "awaiting_audit";
    } else if (
      input.job.audit_head_sha !== input.hints.currentHeadSha ||
      input.hints.auditArtifactStatus !== "current" ||
      input.hints.auditResultReady !== true
    ) {
      return {
        ...input.base,
        ok: false,
        message:
          "completed audit escalation lacks a current same-HEAD audit artifact",
      };
    }
  }

  const updated = input.ledger.updateJobIf(input.job.id, input.job.revision, {
    state: nextState,
    head_sha: input.hints.currentHeadSha,
    last_error: null,
    intervention_resolved_at: new Date().toISOString(),
  });
  if (!updated) {
    return {
      ...input.base,
      ok: false,
      message: "job changed before intervention resolution; re-run dry-run",
    };
  }
  return {
    ...input.base,
    ok: true,
    message:
      intervention.kind === "decision_gate"
        ? `decision sent; restored ${nextState}`
        : `escalation acknowledged; advanced to ${nextState}`,
    details: {
      ...input.base.details,
      intervention,
      nextState,
      headSha: input.hints.currentHeadSha,
    },
    executed: true,
  };
}

function executeAction(
  action: RecoverAction,
  opts: {
    configPath?: string;
    ledgerPath?: string;
    lockPath?: string;
    waitMergeTimeoutMinutes: number;
    jobId?: string;
    implementerTaskId?: string | null;
    implementerDispatchId?: string | null;
    hints: ReconcileHints;
  },
): RecoverResult {
  switch (action.kind) {
    case "run_once":
    case "finalize_implement":
    case "retry_implement":
    case "continue_implement": {
      const recoversBlockedImplementation =
        action.kind === "retry_implement" ||
        action.kind === "finalize_implement" ||
        action.kind === "continue_implement";
      if (
        recoversBlockedImplementation &&
        (!opts.jobId || !opts.implementerTaskId)
      ) {
        return {
          ok: false,
          message: "recover→run-once: missing blocked implementation identity",
          action,
          jobId: opts.jobId,
          executed: false,
        };
      }
      const r = runOnce({
        configPath: opts.configPath,
        ledgerPath: opts.ledgerPath,
        lockPath: opts.lockPath,
        blockedImplementationRecovery:
          recoversBlockedImplementation
            ? {
                action:
                  action.kind === "retry_implement"
                    ? "retry"
                    : action.kind === "continue_implement"
                      ? "continue"
                      : "finalize",
                jobId: opts.jobId!,
                taskId: opts.implementerTaskId!,
                dispatchId: opts.implementerDispatchId ?? null,
              }
            : undefined,
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
  config: RuntimeHarnessConfig,
  job: Job | null,
  project: RepoConfig | null,
): ReconcileHints {
  const hints: ReconcileHints = {};
  if (!job) return hints;

  if (project) {
    const issue = viewIssue(project, job.issue_number);
    if (issue.ok && issue.issue) {
      hints.issueState = issue.issue.state;
    } else {
      hints.issueStateError = issue.error ?? "issue state unavailable";
    }
  }

  if (job.worktree_path) {
    hints.worktreeExists = existsSync(job.worktree_path);
    if (hints.worktreeExists && job.base_sha) {
      const head = revParse(job.worktree_path, "HEAD");
      hints.currentHeadSha = head;
      if (head) {
        const ancestry = checkAncestor(
          job.worktree_path,
          job.base_sha,
          head,
        );
        if (ancestry.ok) {
          hints.baseIsAncestor = ancestry.isAncestor;
        } else {
          hints.baseAncestryError = ancestry.error;
        }
      }
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
      if (tracked.ok) {
        hints.trackedClean = !tracked.stdout.trim();
      }

      const resultPath = join(job.worktree_path, ".harness", "audit-result.json");
      if (head) {
        const artifact = inspectAuditArtifact(
          resultPath,
          job.base_sha,
          head,
        );
        hints.auditArtifactStatus = artifact.status;
        hints.auditResultReady = artifact.status === "current";
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
  if (project && job.branch) {
    if (job.pr_url || job.pr_number) {
      const v = viewPullRequest(project, job.pr_url ?? String(job.pr_number));
      if (v.ok && v.pr) {
        hints.prExists = true;
        hints.prMerged = Boolean(v.pr.mergedAt) || v.pr.state === "MERGED";
        hints.prClosedUnmerged = v.pr.state === "CLOSED" && !v.pr.mergedAt;
      }
    } else {
      const found = findPrByHead(project, job.branch);
      hints.prExists = Boolean(found.pr);
      if (found.pr) {
        const v = viewPullRequest(project, found.pr.number);
        if (v.ok && v.pr) {
          hints.prMerged = Boolean(v.pr.mergedAt) || v.pr.state === "MERGED";
          hints.prClosedUnmerged = v.pr.state === "CLOSED" && !v.pr.mergedAt;
        }
      }
    }
  }

  return hints;
}
