import type { AuditArtifactInspection } from "./audit-gate.js";
import { isRetryablePushFailure } from "./push-failure.js";
import { parseWorkerIntervention } from "./intervention.js";
import type { Job, JobState } from "./types.js";

export const IMPLEMENT_NO_COMMITS_ERROR =
  "implement finished but no commits since base";
export const REWORK_NO_COMMITS_AFTER_AUDITED_HEAD_ERROR =
  "rework produced no commits after audited HEAD";

export function isTimedOutReworkWithoutNewCommit(
  job: Pick<Job, "audit_round" | "last_error">,
): boolean {
  return Boolean(
    job.audit_round > 0 &&
      job.last_error?.startsWith("timeout waiting for worker_done") &&
      job.last_error.includes(REWORK_NO_COMMITS_AFTER_AUDITED_HEAD_ERROR),
  );
}

/** A completed rework can race a transient dispatched-task observation. */
export function isStaleReworkTaskStatusError(error: string | null): boolean {
  return Boolean(
    error &&
      /^rework task \S+ is not completed \(Orca status=dispatched\)$/.test(error),
  );
}

/**
 * The auditor completed, but its immutable snapshot was invalidated by a
 * committed HEAD change before the final gate check.
 */
export function isAuditHeadChangedError(error: string | null): boolean {
  return Boolean(error?.startsWith("HEAD changed during audit: "));
}

/** A completed implementation can race a transient dispatched-task observation. */
export function isStaleImplementationTaskStatusError(
  error: string | null,
): boolean {
  return Boolean(
    error &&
      /^implementation task \S+ is not completed \(Orca status=dispatched\)$/.test(
        error,
      ),
  );
}

/** A timed-out implementation may need an explicit verification handoff. */
export function isTimedOutImplementationTaskError(
  error: string | null,
  taskId: string | null,
): boolean {
  return Boolean(
    error &&
      taskId &&
      error === `timeout waiting for worker_done on task ${taskId}`,
  );
}

/**
 * A failed implementation that left a clean commit may be continued only when
 * the controller's recorded error identifies the same task (timeout) or a
 * stale dispatched-task observation. The continuation must still verify and
 * produce worker_done; commits alone never complete the job.
 */
export function isRecoverableImplementationContinuationError(
  error: string | null,
  taskId: string | null,
): boolean {
  return (
    isTimedOutImplementationTaskError(error, taskId) ||
    isStaleImplementationTaskStatusError(error)
  );
}

/**
 * Pi has already consumed its own bounded provider retries. This is distinct
 * from an audit finding: no result was produced, so a fresh auditor is needed
 * once the provider is healthy again.
 */
export function isExhaustedAuditProviderError(error: string | null): boolean {
  return Boolean(
    error &&
      /^(?:provider request|provider Responses stream) failed after Pi exhausted its retries$/.test(
        error,
      ),
  );
}

/** A rework dispatch can fail before Pi creates a commit. */
export function isExhaustedReworkProviderError(error: string | null): boolean {
  return Boolean(
    error &&
      /^(?:provider request|provider Responses stream) failed after Pi exhausted its retries; rework produced no commits after audited HEAD$/.test(
        error,
      ),
  );
}

/**
 * Pure recovery routing for M5.
 * Controllers map each non-terminal state to the next safe command.
 * Side effects stay in ensure* / *Once implementations.
 */
export type RecoverAction =
  | { kind: "noop"; reason: string }
  | { kind: "run_once"; reason: string }
  | { kind: "finalize_implement"; reason: string }
  | { kind: "retry_implement"; reason: string }
  | { kind: "continue_implement"; reason: string }
  | {
      kind: "audit_once";
      reason: string;
      recovery?:
        | "retry_malformed_result"
        | "retry_stuck_rework"
        | "retry_exhausted_rework_provider"
        | "retry_validation_only_rework"
        | "retry_stale_result"
        | "retry_snapshot_mismatch"
        | "resume_completed_rework"
        | "retry_exhausted_provider";
    }
  | { kind: "publish_once"; reason: string }
  | { kind: "wait_merge"; reason: string }
  | {
      kind: "resolve_intervention";
      reason: string;
      intervention: "escalation" | "decision_gate";
    }
  | { kind: "blocked"; reason: string; persist?: boolean }
  | { kind: "none"; reason: string };

export type RecoverExecution = "automatic" | "explicit_recovery" | "none";

export function classifyRecoverExecution(
  action: RecoverAction,
  state?: JobState,
): RecoverExecution {
  if (
    action.kind === "retry_implement" ||
    action.kind === "finalize_implement" ||
    action.kind === "continue_implement" ||
    (state === "blocked" && action.kind === "audit_once") ||
    action.kind === "resolve_intervention"
  ) {
    return "explicit_recovery";
  }

  if (
    action.kind === "run_once" ||
    action.kind === "audit_once" ||
    action.kind === "publish_once" ||
    action.kind === "wait_merge" ||
    (action.kind === "blocked" && action.persist) ||
    (action.kind === "none" && state === undefined)
  ) {
    return "automatic";
  }

  return "none";
}

export type ReconcileHints = {
  /** Worktree path exists on disk. */
  worktreeExists?: boolean;
  /** HEAD has commits since base_sha. */
  hasCommitsSinceBase?: boolean;
  /** Whether base_sha is a verified ancestor of the current HEAD. */
  baseIsAncestor?: boolean;
  /** Git error when base ancestry could not be verified. */
  baseAncestryError?: string;
  /** Current worktree HEAD SHA, when readable. */
  currentHeadSha?: string | null;
  /** Tracked working tree clean (-uno). */
  trackedClean?: boolean;
  /** Orca orchestration task status if known. */
  implementTaskStatus?: string | null;
  auditTaskStatus?: string | null;
  /** Strict audit artifact classification for the current base and HEAD. */
  auditArtifactStatus?: AuditArtifactInspection["status"];
  /** Strict audit result exists and matches the current base and HEAD. */
  auditResultReady?: boolean;
  /** Remote open PR exists for branch. */
  prExists?: boolean;
  /** PR mergedAt non-null. */
  prMerged?: boolean;
  /** PR closed without merge. */
  prClosedUnmerged?: boolean;
  /** Current GitHub issue state when the lookup succeeds. */
  issueState?: string;
  /** GitHub issue lookup error; informational, not itself a blocker. */
  issueStateError?: string;
};

export function reconcileJob(
  job: Job | null,
  hints: ReconcileHints = {},
): RecoverAction {
  if (!job) {
    return {
      kind: "none",
      reason: "no active job; safe to pick/run-once for a new issue",
    };
  }

  const issueClosed =
    hints.issueState != null && hints.issueState.toUpperCase() !== "OPEN";
  if (
    issueClosed &&
    !(job.state === "awaiting_merge" && hints.prMerged === true)
  ) {
    const reason =
      `GitHub issue ${job.repo}#${job.issue_number} state=${hints.issueState}; ` +
      "explicit cancel required";
    return {
      kind: "blocked",
      reason,
      persist: job.state !== "blocked" || job.last_error !== reason,
    };
  }

  const requiresVerifiedBaseLineage =
    job.state === "implementing" ||
    job.state === "reworking" ||
    job.state === "awaiting_audit" ||
    job.state === "auditing" ||
    job.state === "audit_passed" ||
    job.state === "publishing";
  const baseLineageError = hints.baseAncestryError
    ? `cannot verify pinned base ancestry: ${hints.baseAncestryError}`
    : hints.baseIsAncestor === false
      ? "pinned base SHA is not an ancestor of HEAD"
      : requiresVerifiedBaseLineage && hints.baseIsAncestor !== true
        ? "cannot verify pinned base ancestry: verification result unavailable"
        : null;
  if (
    baseLineageError &&
    job.state !== "awaiting_merge" &&
    job.state !== "merged" &&
    job.state !== "cancelled"
  ) {
    return {
      kind: "blocked",
      reason: baseLineageError,
      persist:
        job.state !== "blocked" || job.last_error !== baseLineageError,
    };
  }

  switch (job.state as JobState) {
    case "merged":
    case "cancelled":
      return { kind: "noop", reason: `terminal state ${job.state}` };

    case "blocked": {
      const intervention = parseWorkerIntervention(job);
      if (intervention && !job.intervention_resolved_at) {
        return {
          kind: "resolve_intervention",
          intervention: intervention.kind,
          reason:
            intervention.kind === "decision_gate"
              ? "worker is waiting for a human decision; inspect the stored request and reply explicitly"
              : "worker escalation requires explicit human acknowledgement before its completed output can advance",
        };
      }
      const implementTaskStatus =
        hints.implementTaskStatus?.toLowerCase() ?? "";
      const implementationEnded = Boolean(
        job.implementer_task_id &&
        (job.last_error === IMPLEMENT_NO_COMMITS_ERROR ||
          isStaleImplementationTaskStatusError(job.last_error)) &&
        hints.worktreeExists === true &&
        ["completed", "failed"].includes(implementTaskStatus),
      );
      if (
        job.implementer_task_id &&
        job.implementer_dispatch_id &&
        isRecoverableImplementationContinuationError(
          job.last_error,
          job.implementer_task_id,
        ) &&
        implementTaskStatus === "failed" &&
        hints.worktreeExists === true &&
        hints.hasCommitsSinceBase === true &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "continue_implement",
          reason:
            "failed implementation left clean commits after its task became unrecoverable; explicit recovery may dispatch a verification continuation",
        };
      }
      if (
        implementationEnded &&
        implementTaskStatus === "failed" &&
        hints.hasCommitsSinceBase === true
      ) {
        return {
          kind: "blocked",
          reason:
            `implementation task ${job.implementer_task_id} failed; ` +
            "commits cannot substitute for task completion",
        };
      }
      if (
        implementationEnded &&
        implementTaskStatus === "completed" &&
        hints.hasCommitsSinceBase === true &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "finalize_implement",
          reason:
            "implementation commits landed after the completion signal; finalize the same issue",
        };
      }
      if (
        implementationEnded &&
        hints.currentHeadSha === job.base_sha &&
        hints.hasCommitsSinceBase === false &&
        hints.baseIsAncestor === true &&
        typeof hints.trackedClean === "boolean"
      ) {
        return {
          kind: "retry_implement",
          reason:
            "implementation task ended without commits; explicit recovery may redispatch the same issue",
        };
      }
      if (
        isRetryablePushFailure(job.last_error) &&
        job.auditor_task_id &&
        job.audit_round > 0 &&
        job.audit_head_sha === hints.currentHeadSha &&
        hints.auditArtifactStatus === "current" &&
        hints.auditResultReady === true &&
        hints.auditTaskStatus?.toLowerCase() === "completed" &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "publish_once",
          reason:
            "blocked push has current completed audit evidence; retry publishing",
        };
      }
      if (
        job.auditor_task_id &&
        job.audit_round > 0 &&
        job.audit_head_sha === hints.currentHeadSha &&
        job.head_sha === hints.currentHeadSha &&
        isExhaustedAuditProviderError(job.last_error) &&
        hints.auditArtifactStatus === "missing" &&
        hints.auditResultReady === false &&
        ["dispatched", "failed"].includes(
          hints.auditTaskStatus?.toLowerCase() ?? "",
        ) &&
        hints.worktreeExists === true &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "audit_once",
          reason:
            "auditor exhausted provider retries without a result; explicit recovery may dispatch a fresh auditor for the same HEAD",
          recovery: "retry_exhausted_provider",
        };
      }
      if (
        job.auditor_task_id &&
        job.audit_round > 0 &&
        job.audit_head_sha === hints.currentHeadSha &&
        hints.auditArtifactStatus === "malformed" &&
        hints.auditTaskStatus?.toLowerCase() === "completed" &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "audit_once",
          reason:
            "completed audit produced a malformed result; explicit recovery may dispatch a fresh auditor",
          recovery: "retry_malformed_result",
        };
      }
      if (
        job.implementer_task_id &&
        job.audit_round > 0 &&
        job.audit_head_sha &&
        isStaleReworkTaskStatusError(job.last_error) &&
        typeof hints.currentHeadSha === "string" &&
        hints.currentHeadSha !== job.audit_head_sha &&
        hints.worktreeExists === true &&
        hints.hasCommitsSinceBase === true &&
        hints.auditArtifactStatus === "stale" &&
        hints.implementTaskStatus?.toLowerCase() === "completed" &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "audit_once",
          reason:
            "completed rework followed a stale dispatched-task observation; explicit recovery may re-audit the clean descendant",
          recovery: "resume_completed_rework",
        };
      }
      if (
        job.implementer_task_id &&
        job.implementer_dispatch_id &&
        isTimedOutReworkWithoutNewCommit(job) &&
        job.audit_head_sha === hints.currentHeadSha &&
        job.head_sha === hints.currentHeadSha &&
        hints.worktreeExists === true &&
        hints.hasCommitsSinceBase === true &&
        hints.auditArtifactStatus === "current" &&
        hints.auditResultReady === true &&
        hints.implementTaskStatus?.toLowerCase() === "failed" &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "audit_once",
          reason:
            "timed-out zero-commit rework has a failed stale task; explicit recovery may redispatch the same issue",
          recovery: "retry_stuck_rework",
        };
      }
      if (
        job.implementer_task_id &&
        job.implementer_dispatch_id &&
        job.audit_round > 0 &&
        isExhaustedReworkProviderError(job.last_error) &&
        job.audit_head_sha === hints.currentHeadSha &&
        job.head_sha === hints.currentHeadSha &&
        hints.worktreeExists === true &&
        hints.hasCommitsSinceBase === true &&
        hints.auditArtifactStatus === "current" &&
        hints.auditResultReady === true &&
        hints.implementTaskStatus?.toLowerCase() === "failed" &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "audit_once",
          reason:
            "rework implementer exhausted provider retries without a commit; explicit recovery may redispatch the same issue",
          recovery: "retry_exhausted_rework_provider",
        };
      }
      if (
        job.implementer_task_id &&
        job.audit_round > 0 &&
        job.last_error === REWORK_NO_COMMITS_AFTER_AUDITED_HEAD_ERROR &&
        job.audit_head_sha === hints.currentHeadSha &&
        job.head_sha === hints.currentHeadSha &&
        hints.worktreeExists === true &&
        hints.hasCommitsSinceBase === true &&
        hints.auditArtifactStatus === "current" &&
        hints.implementTaskStatus?.toLowerCase() === "completed" &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "audit_once",
          reason:
            "completed validation-only rework may explicitly dispatch a fresh auditor for the same HEAD",
          recovery: "retry_validation_only_rework",
        };
      }
      if (
        job.auditor_task_id &&
        job.audit_round > 0 &&
        job.audit_head_sha &&
        job.head_sha === job.audit_head_sha &&
        isAuditHeadChangedError(job.last_error) &&
        typeof hints.currentHeadSha === "string" &&
        job.audit_head_sha !== hints.currentHeadSha &&
        hints.auditArtifactStatus === "current" &&
        hints.auditTaskStatus?.toLowerCase() === "completed" &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "audit_once",
          reason:
            "audit snapshot changed after dispatch; dispatch a fresh audit for the clean descendant",
          recovery: "retry_snapshot_mismatch",
        };
      }
      if (
        job.auditor_task_id &&
        job.audit_round > 0 &&
        typeof hints.currentHeadSha === "string" &&
        job.audit_head_sha !== hints.currentHeadSha &&
        hints.auditArtifactStatus === "stale" &&
        hints.auditTaskStatus?.toLowerCase() === "completed" &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "audit_once",
          reason:
            "clean commits landed after the completed audit; dispatch a fresh audit",
          recovery: "retry_stale_result",
        };
      }
      if (
        job.auditor_task_id &&
        job.audit_round > 0 &&
        job.audit_head_sha === hints.currentHeadSha &&
        isRecoverableAuditWaitError(job.last_error) &&
        hints.auditResultReady === true &&
        hints.auditTaskStatus?.toLowerCase() === "completed" &&
        hints.baseIsAncestor === true &&
        hints.trackedClean === true
      ) {
        return {
          kind: "audit_once",
          reason:
            "blocked audit wait completed with a current result; resume gate evaluation",
        };
      }
      return {
        kind: "blocked",
        reason: job.last_error ?? "blocked; needs human cancel/resume",
      };
    }

    case "claimed":
    case "worktree_ready":
      return {
        kind: "run_once",
        reason: `${job.state}: ensure worktree + implement (idempotent)`,
      };

    case "implementing":
      if (
        hints.hasCommitsSinceBase &&
        hints.implementTaskStatus?.toLowerCase() === "failed"
      ) {
        return {
          kind: "run_once",
          reason:
            "failed implementation task has commits; resume will record a block",
        };
      }
      // Crash after Codex finished but before ledger flip:
      if (
        hints.hasCommitsSinceBase &&
        hints.trackedClean === true &&
        hints.implementTaskStatus?.toLowerCase() === "completed"
      ) {
        // Still route through run_once which will detect commits and flip.
        return {
          kind: "run_once",
          reason:
            "implementing with commits present; resume will finalize to awaiting_audit",
        };
      }
      return {
        kind: "run_once",
        reason: "implementing: resume wait or re-dispatch implementer",
      };

    case "reworking":
      return {
        kind: "audit_once",
        reason: "reworking: audit-once owns rework→re-audit loop",
      };

    case "awaiting_audit":
      return {
        kind: "audit_once",
        reason: "awaiting_audit: run dual-axis audit",
      };

    case "auditing":
      if (hints.auditResultReady) {
        return {
          kind: "audit_once",
          reason:
            "auditing with result file present; resume will evaluate gate without duplicate PR",
        };
      }
      return {
        kind: "audit_once",
        reason: "auditing: resume wait or re-dispatch auditor",
      };

    case "audit_passed":
      return {
        kind: "publish_once",
        reason: "audit_passed: ensure push + PR",
      };

    case "publishing":
      if (hints.prExists || job.pr_url) {
        return {
          kind: "publish_once",
          reason: "publishing with PR present; ensure ledger awaiting_merge",
        };
      }
      return {
        kind: "publish_once",
        reason: "publishing: ensure push + PR (no duplicate create)",
      };

    case "awaiting_merge":
      if (hints.prMerged) {
        return {
          kind: "wait_merge",
          reason: "awaiting_merge but PR already merged; record merged",
        };
      }
      if (hints.prClosedUnmerged) {
        return {
          kind: "wait_merge",
          reason: "PR closed unmerged; wait-merge will block",
        };
      }
      return {
        kind: "wait_merge",
        reason: "awaiting_merge: poll GitHub for mergedAt",
      };

    default:
      return {
        kind: "blocked",
        reason: `unknown state ${(job as Job).state}`,
      };
  }
}

function isRecoverableAuditWaitError(error: string | null): boolean {
  return Boolean(
    error &&
      (error.includes("decision_gate") ||
        error.startsWith("timeout waiting for worker_done")),
  );
}

/** Invariants that recovery must never violate (checked in tests). */
export function recoveryInvariants(): string[] {
  return [
    "never claim a second issue while a non-terminal job exists",
    "never create a second worktree for the same issue if one exists",
    "never create a second PR for the same head branch if one exists",
    "never advance work whose HEAD does not descend from the pinned base",
    "never reuse a malformed audit result; recover only through a fresh audit",
    "never retry timed-out rework before the failed task and audited fixed point are revalidated",
    "never skip audit (audit_passed/publishing only after audit gate)",
    "never pick next issue before merged/cancelled",
  ];
}
