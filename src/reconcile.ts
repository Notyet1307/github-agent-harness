import type { Job, JobState } from "./types.js";

export const IMPLEMENT_NO_COMMITS_ERROR =
  "implement finished but no commits since base";

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
  | { kind: "audit_once"; reason: string }
  | { kind: "publish_once"; reason: string }
  | { kind: "wait_merge"; reason: string }
  | { kind: "blocked"; reason: string; persist?: boolean }
  | { kind: "none"; reason: string };

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
  /** Strict audit result exists and matches the current base and HEAD. */
  auditResultReady?: boolean;
  /** Remote open PR exists for branch. */
  prExists?: boolean;
  /** PR mergedAt non-null. */
  prMerged?: boolean;
  /** PR closed without merge. */
  prClosedUnmerged?: boolean;
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
      persist: job.state !== "blocked",
    };
  }

  switch (job.state as JobState) {
    case "merged":
    case "cancelled":
      return { kind: "noop", reason: `terminal state ${job.state}` };

    case "blocked": {
      const implementTaskStatus =
        hints.implementTaskStatus?.toLowerCase() ?? "";
      const implementationEnded = Boolean(
        job.implementer_task_id &&
        job.last_error === IMPLEMENT_NO_COMMITS_ERROR &&
        hints.worktreeExists === true &&
        ["completed", "failed"].includes(implementTaskStatus),
      );
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
    "never skip audit (audit_passed/publishing only after audit gate)",
    "never pick next issue before merged/cancelled",
  ];
}
