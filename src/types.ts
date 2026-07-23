export type RepoConfig = {
  github: string;
  localPath: string;
  orcaRepoId: string;
  baseRef: string;
  defaultBranch: string;
};

export type MergePolicy = {
  mode: "wait";
  autoMerge: false;
};

/** Stable role in the pipeline — not a product brand. */
export type AgentRole = "implementer" | "auditor";

/**
 * Pluggable agent profile. V1 ships codex implementer + pi auditor stub.
 * Future: multiple Pi profiles with different providers/extensions.
 */
export type AgentProfile = {
  id: string;
  role: AgentRole;
  /** How the worker is launched. V1 only supports orca. */
  runtime: "orca";
  /** Orca known agent id: codex | pi | claude | … */
  orcaAgent: string;
  /** Optional full command override for terminal create (e.g. custom pi argv). */
  command?: string;
  /** Env vars reserved for future launch plumbing (e.g. PI_CODING_AGENT_DIR). */
  env?: Record<string, string>;
  /** Hint forced into the task spec so skills with disable-model-invocation still run. */
  invokeHint: string;
  /** Auditor profiles must be readonly. */
  readonly?: boolean;
};

export type HarnessConfig = {
  version: number;
  issueLabel: string;
  pollIntervalSeconds: number;
  maxConcurrentTotal: number;
  maxAuditRounds: number;
  /** Minutes to wait for implementer worker_done (M2). */
  implementTimeoutMinutes: number;
  /** Minutes to wait for auditor worker_done (M3). */
  auditTimeoutMinutes: number;
  mergePolicy: MergePolicy;
  orca: {
    cliPath: string;
    cliPathFallback: string;
    controllerWorktreePath: string;
    controllerTitle: string;
  };
  /** Active profile ids by role. */
  activeProfiles: {
    implementer: string;
    auditor: string;
  };
  agentProfiles: Record<string, AgentProfile>;
  repositories: RepoConfig[];
};

export type IssueCandidate = {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  /** Dependency blockers; may include closed issues from GitHub JSON. */
  blockedBy: Array<{ number: number; title?: string; state?: string }>;
  labels: string[];
};

/** True only if blocked by at least one still-OPEN issue. */
export function hasOpenBlockers(
  blockedBy: Array<{ number: number; state?: string }>,
): boolean {
  return blockedBy.some((b) => {
    const s = (b.state ?? "OPEN").toUpperCase();
    return s === "OPEN";
  });
}

export type PickSkipReason =
  | "no-ready-label"
  | "blocked"
  | "already-in-ledger"
  | "not-open"
  | "other";

export type PickSkip = {
  number: number;
  title: string;
  reason: PickSkipReason;
  detail?: string;
};

export type PickResult = {
  repo: RepoConfig;
  selected: IssueCandidate | null;
  skipped: PickSkip[];
  eligible: IssueCandidate[];
};

/** Non-terminal states block picking the next issue (V1 single slot). */
export type JobState =
  | "claimed"
  | "worktree_ready"
  | "implementing"
  | "awaiting_audit"
  | "auditing"
  | "reworking"
  | "audit_passed"
  | "publishing"
  | "awaiting_merge"
  | "merged"
  | "blocked"
  | "cancelled";

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set([
  "merged",
  "cancelled",
]);

export type Job = {
  id: string;
  repo: string;
  issue_number: number;
  issue_url: string;
  issue_updated_at: string;
  issue_snapshot_json: string;
  state: JobState;
  base_ref: string;
  base_sha: string | null;
  branch: string | null;
  worktree_id: string | null;
  worktree_path: string | null;
  implementer_profile_id: string | null;
  implementer_terminal_handle: string | null;
  implementer_task_id: string | null;
  implementer_dispatch_id: string | null;
  auditor_profile_id: string | null;
  auditor_terminal_handle: string | null;
  auditor_task_id: string | null;
  auditor_dispatch_id: string | null;
  /** Attempt number for the currently active role dispatch (0 = none). */
  dispatch_attempt: number;
  /** 1 while dispatch acceptance is not yet confirmed. */
  dispatch_probe_pending: number;
  controller_terminal_handle: string | null;
  audit_round: number;
  audit_result_json: string | null;
  audit_head_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  merged_at: string | null;
  last_error: string | null;
  head_sha: string | null;
  created_at: string;
  updated_at: string;
};

export type AuditFinding = {
  summary: string;
  detail?: string;
  /** Default true for hard findings; smells should set false. */
  blocking?: boolean;
};

export type AuditResult = {
  status: "pass" | "fail" | "uncertain";
  base_sha: string;
  head_sha: string;
  standards: {
    documented_standard_violations: AuditFinding[];
    smell_judgement_calls: AuditFinding[];
  };
  spec: {
    missing_or_partial: AuditFinding[];
    incorrect_implementation: AuditFinding[];
    scope_creep: AuditFinding[];
  };
  validation: {
    commands: Array<{ command: string; exit_code: number; ok: boolean }>;
  };
  notes?: string;
};
