import test from "node:test";
import assert from "node:assert/strict";
import {
  IMPLEMENT_NO_COMMITS_ERROR,
  REWORK_NO_COMMITS_AFTER_AUDITED_HEAD_ERROR,
  classifyRecoverExecution,
  reconcileJob,
  recoveryInvariants,
} from "../src/reconcile.js";
import type { Job } from "../src/types.js";

function job(partial: Partial<Job> & { state: Job["state"] }): Job {
  return {
    id: "j1",
    repo: "Notyet1307/harness-sandbox",
    issue_number: 99,
    issue_url: "https://example/issues/99",
    issue_updated_at: "t",
    issue_snapshot_json: "{}",
    state: partial.state,
    base_ref: "origin/main",
    base_sha: "base",
    branch: "agent/issue-99",
    worktree_id: "wt",
    worktree_path: "/tmp/wt",
    implementer_profile_id: "codex-default",
    implementer_terminal_handle: null,
    implementer_task_id: null,
    implementer_dispatch_id: null,
    auditor_profile_id: null,
    auditor_terminal_handle: null,
    auditor_task_id: null,
    auditor_dispatch_id: null,
    dispatch_attempt: 0,
    dispatch_probe_pending: 0,
    controller_terminal_handle: null,
    audit_round: 0,
    audit_result_json: null,
    audit_head_sha: null,
    pr_number: null,
    pr_url: null,
    merged_at: null,
    last_error: null,
    head_sha: null,
    created_at: "t",
    updated_at: "t",
    ...partial,
  };
}

test("no active job → none (safe to claim next)", () => {
  const a = reconcileJob(null);
  assert.equal(a.kind, "none");
});

test("claimed / worktree_ready → run_once", () => {
  assert.equal(reconcileJob(job({ state: "claimed" })).kind, "run_once");
  assert.equal(reconcileJob(job({ state: "worktree_ready" })).kind, "run_once");
});

test("implementing with completed task commits → run_once finalize path", () => {
  const a = reconcileJob(job({ state: "implementing" }), {
    hasCommitsSinceBase: true,
    baseIsAncestor: true,
    trackedClean: true,
    implementTaskStatus: "completed",
  });
  assert.equal(a.kind, "run_once");
  assert.match(a.reason, /commits/i);
});

test("completed task commits do not plan finalize without tracked status", () => {
  const a = reconcileJob(job({ state: "implementing" }), {
    hasCommitsSinceBase: true,
    baseIsAncestor: true,
    implementTaskStatus: "completed",
  });

  assert.equal(a.kind, "run_once");
  assert.doesNotMatch(a.reason, /finalize/i);
});

test("implementing with commits from a failed task records a block", () => {
  const a = reconcileJob(
    job({
      state: "implementing",
      implementer_task_id: "task-implement",
    }),
    {
      hasCommitsSinceBase: true,
      baseIsAncestor: true,
      trackedClean: true,
      implementTaskStatus: "failed",
    },
  );

  assert.equal(a.kind, "run_once");
  assert.match(a.reason, /failed.*record.*block/i);
});

test("awaiting_audit → audit_once", () => {
  assert.equal(
    reconcileJob(job({ state: "awaiting_audit" }), {
      baseIsAncestor: true,
    }).kind,
    "audit_once",
  );
});

test("auditing with result file → audit_once", () => {
  const a = reconcileJob(job({ state: "auditing" }), {
    auditResultReady: true,
    baseIsAncestor: true,
  });
  assert.equal(a.kind, "audit_once");
});

test("audit_passed → publish_once", () => {
  assert.equal(
    reconcileJob(job({ state: "audit_passed" }), {
      baseIsAncestor: true,
    }).kind,
    "publish_once",
  );
});

test("publishing with existing PR → publish_once (ensure, not create)", () => {
  const a = reconcileJob(job({ state: "publishing" }), {
    prExists: true,
    baseIsAncestor: true,
  });
  assert.equal(a.kind, "publish_once");
});

test("awaiting_merge + already merged → wait_merge", () => {
  const a = reconcileJob(job({ state: "awaiting_merge", pr_url: "u" }), {
    prMerged: true,
  });
  assert.equal(a.kind, "wait_merge");
});

test("awaiting_merge closed unmerged → wait_merge (will block)", () => {
  const a = reconcileJob(job({ state: "awaiting_merge" }), {
    prClosedUnmerged: true,
  });
  assert.equal(a.kind, "wait_merge");
});

test("blocked stays blocked", () => {
  const a = reconcileJob(job({ state: "blocked", last_error: "x" }));
  assert.equal(a.kind, "blocked");
});

test("a closed active issue blocks and requires explicit cancellation", () => {
  const a = reconcileJob(job({ state: "awaiting_audit" }), {
    issueState: "CLOSED",
    baseIsAncestor: true,
  });
  assert.equal(a.kind, "blocked");
  assert.match(a.reason, /explicit cancel required/);
  assert.equal(a.kind === "blocked" ? a.persist : false, true);
});

test("a merged PR can be recorded even when GitHub already closed its issue", () => {
  const a = reconcileJob(job({ state: "awaiting_merge" }), {
    issueState: "CLOSED",
    prMerged: true,
  });
  assert.equal(a.kind, "wait_merge");
});

test("a structured escalation requires explicit intervention recovery", () => {
  const a = reconcileJob(
    job({
      state: "blocked",
      implementer_task_id: "task-1",
      implementer_dispatch_id: "dispatch-1",
      intervention_json: JSON.stringify({
        version: 1,
        kind: "escalation",
        sourceState: "implementing",
        role: "implementer",
        messageId: "message-1",
        taskId: "task-1",
        dispatchId: "dispatch-1",
        headSha: "head-1",
        body: "confirm scope",
        payload: null,
        observedAt: "2026-07-29T00:00:00Z",
      }),
    }),
    { baseIsAncestor: true },
  );
  assert.equal(a.kind, "resolve_intervention");
  assert.equal(
    a.kind === "resolve_intervention" ? a.intervention : null,
    "escalation",
  );
  assert.equal(classifyRecoverExecution(a, "blocked"), "explicit_recovery");
});

test("completed implementation without commits requires an explicit retry", () => {
  const a = reconcileJob(
    job({
      state: "blocked",
      implementer_task_id: "task-implement",
      last_error: IMPLEMENT_NO_COMMITS_ERROR,
    }),
    {
      worktreeExists: true,
      currentHeadSha: "base",
      hasCommitsSinceBase: false,
      baseIsAncestor: true,
      trackedClean: false,
      implementTaskStatus: "completed",
    },
  );

  assert.equal(a.kind, "retry_implement");
});

test("implementation retry requires a readable base HEAD and tracked status", () => {
  for (const hints of [
    {
      worktreeExists: true,
      currentHeadSha: null,
      hasCommitsSinceBase: false,
      trackedClean: false,
      implementTaskStatus: "completed",
    },
    {
      worktreeExists: true,
      currentHeadSha: "base",
      hasCommitsSinceBase: false,
      baseIsAncestor: true,
      implementTaskStatus: "completed",
    },
  ]) {
    const a = reconcileJob(
      job({
        state: "blocked",
        implementer_task_id: "task-implement",
        last_error: IMPLEMENT_NO_COMMITS_ERROR,
      }),
      hints,
    );
    assert.equal(a.kind, "blocked");
  }
});

test("completed implementation with clean commits can be finalized", () => {
  const a = reconcileJob(
    job({
      state: "blocked",
      implementer_task_id: "task-implement",
      last_error: IMPLEMENT_NO_COMMITS_ERROR,
    }),
    {
      worktreeExists: true,
      hasCommitsSinceBase: true,
      baseIsAncestor: true,
      trackedClean: true,
      implementTaskStatus: "completed",
    },
  );

  assert.equal(a.kind, "finalize_implement");
});

test("completed implementation recovers after a stale dispatched-task observation", () => {
  const a = reconcileJob(
    job({
      state: "blocked",
      implementer_task_id: "task-implement",
      last_error:
        "implementation task task-implement is not completed (Orca status=dispatched)",
    }),
    {
      worktreeExists: true,
      hasCommitsSinceBase: true,
      baseIsAncestor: true,
      trackedClean: true,
      implementTaskStatus: "completed",
    },
  );

  assert.equal(a.kind, "finalize_implement");
});

test("completed implementation with divergent HEAD cannot be finalized", () => {
  const a = reconcileJob(
    job({
      state: "blocked",
      implementer_task_id: "task-implement",
      last_error: IMPLEMENT_NO_COMMITS_ERROR,
    }),
    {
      worktreeExists: true,
      hasCommitsSinceBase: true,
      baseIsAncestor: false,
      trackedClean: true,
      implementTaskStatus: "completed",
    },
  );

  assert.equal(a.kind, "blocked");
  assert.match(a.reason, /not an ancestor/i);
});

test("recovery planning blocks divergent pre-publish states", () => {
  for (const state of [
    "implementing",
    "reworking",
    "awaiting_audit",
    "auditing",
    "audit_passed",
    "publishing",
  ] as const) {
    const a = reconcileJob(job({ state }), {
      baseIsAncestor: false,
    });
    assert.equal(a.kind, "blocked", state);
    assert.match(a.reason, /not an ancestor/i, state);
  }
});

test("recovery planning blocks unverified pre-publish lineage", () => {
  for (const state of [
    "implementing",
    "reworking",
    "awaiting_audit",
    "auditing",
    "audit_passed",
    "publishing",
  ] as const) {
    const a = reconcileJob(job({ state }));
    assert.equal(a.kind, "blocked", state);
    assert.match(a.reason, /cannot verify.*ancestry/i, state);
  }
});

test("recovery planning reports base ancestry errors before commit counts", () => {
  const a = reconcileJob(
    job({
      state: "blocked",
      implementer_task_id: "task-implement",
      last_error: IMPLEMENT_NO_COMMITS_ERROR,
    }),
    {
      worktreeExists: true,
      currentHeadSha: "head",
      hasCommitsSinceBase: false,
      baseAncestryError: "fatal: bad object base",
      trackedClean: true,
      implementTaskStatus: "completed",
    },
  );

  assert.equal(a.kind, "blocked");
  assert.match(a.reason, /cannot verify.*bad object base/i);
});

test("premature completion stays blocked while its task is still live", () => {
  const a = reconcileJob(
    job({
      state: "blocked",
      implementer_task_id: "task-implement",
      last_error: IMPLEMENT_NO_COMMITS_ERROR,
    }),
    {
      worktreeExists: true,
      hasCommitsSinceBase: false,
      trackedClean: false,
      implementTaskStatus: "dispatched",
    },
  );

  assert.equal(a.kind, "blocked");
});

test("blocked malformed audit routes to a fresh explicit recovery", () => {
  const action = reconcileJob(
    job({
      state: "blocked",
      auditor_task_id: "task-audit",
      audit_round: 1,
      audit_head_sha: "head",
      head_sha: "head",
      last_error: "invalid audit result: standards finding lists are invalid",
    }),
    {
      auditArtifactStatus: "malformed",
      auditResultReady: false,
      auditTaskStatus: "completed",
      baseIsAncestor: true,
      trackedClean: true,
      currentHeadSha: "head",
    },
  );

  assert.equal(action.kind, "audit_once");
  if (action.kind === "audit_once") {
    assert.equal(action.recovery, "retry_malformed_result");
  }
});

test("blocked exhausted audit provider routes only a same-HEAD, result-less audit to explicit recovery", () => {
  const action = reconcileJob(
    job({
      state: "blocked",
      auditor_task_id: "task-audit",
      audit_round: 1,
      audit_head_sha: "head",
      head_sha: "head",
      last_error: "provider request failed after Pi exhausted its retries",
    }),
    {
      worktreeExists: true,
      auditArtifactStatus: "missing",
      auditResultReady: false,
      auditTaskStatus: "dispatched",
      baseIsAncestor: true,
      trackedClean: true,
      currentHeadSha: "head",
    },
  );

  assert.equal(action.kind, "audit_once");
  if (action.kind === "audit_once") {
    assert.equal(action.recovery, "retry_exhausted_provider");
  }

  assert.equal(
    reconcileJob(
      job({
        state: "blocked", auditor_task_id: "task-audit", audit_round: 1,
        audit_head_sha: "head", head_sha: "head",
        last_error: "provider request failed after Pi exhausted its retries",
      }),
      {
        worktreeExists: true, auditArtifactStatus: "missing", auditResultReady: false,
        auditTaskStatus: "dispatched", baseIsAncestor: true, trackedClean: true,
        currentHeadSha: "other-head",
      },
    ).kind,
    "blocked",
  );
});

test("blocked stale audit retries against a newer clean HEAD", () => {
  const action = reconcileJob(
    job({
      state: "blocked",
      auditor_task_id: "task-audit",
      audit_round: 1,
      audit_head_sha: "audited-head",
      head_sha: "audited-head",
      last_error: "auditor reported uncertain",
    }),
    {
      auditArtifactStatus: "stale",
      auditResultReady: false,
      auditTaskStatus: "completed",
      baseIsAncestor: true,
      trackedClean: true,
      currentHeadSha: "newer-head",
    },
  );

  assert.equal(action.kind, "audit_once");
  if (action.kind === "audit_once") {
    assert.equal(action.recovery, "retry_stale_result");
  }
});

test("blocked transient push failure retries publishing with current audit evidence", () => {
  const action = reconcileJob(
    job({
      state: "blocked",
      auditor_task_id: "task-audit",
      audit_round: 1,
      audit_head_sha: "head",
      head_sha: "head",
      last_error:
        "git push failed: fatal: unable to access 'https://github.com/owner/repo.git/': Could not resolve host: github.com",
    }),
    {
      auditArtifactStatus: "current",
      auditResultReady: true,
      auditTaskStatus: "completed",
      baseIsAncestor: true,
      trackedClean: true,
      currentHeadSha: "head",
    },
  );

  assert.equal(action.kind, "publish_once");
});

test("blocked permanent push failure does not retry publishing", () => {
  const action = reconcileJob(
    job({
      state: "blocked",
      auditor_task_id: "task-audit",
      audit_round: 1,
      audit_head_sha: "head",
      head_sha: "head",
      last_error:
        "git push failed: remote: Permission to owner/repo.git denied to bot.",
    }),
    {
      auditArtifactStatus: "current",
      auditResultReady: true,
      auditTaskStatus: "completed",
      baseIsAncestor: true,
      trackedClean: true,
      currentHeadSha: "head",
    },
  );

  assert.equal(action.kind, "blocked");
});

test("blocked malformed audit stays blocked without completed provenance", () => {
  const action = reconcileJob(
    job({
      state: "blocked",
      auditor_task_id: "task-audit",
      audit_round: 1,
      audit_head_sha: "head",
      head_sha: "head",
      last_error: "invalid audit result: standards finding lists are invalid",
    }),
    {
      auditArtifactStatus: "malformed",
      auditResultReady: false,
      auditTaskStatus: "working",
      baseIsAncestor: true,
      trackedClean: true,
      currentHeadSha: "head",
    },
  );

  assert.equal(action.kind, "blocked");
});

test("validation-only rework can explicitly request a fresh audit of the same SHA", () => {
  const action = reconcileJob(
    job({
      state: "blocked",
      implementer_task_id: "task-rework",
      audit_round: 1,
      audit_head_sha: "head",
      head_sha: "head",
      last_error: "rework produced no commits after audited HEAD",
    }),
    {
      auditArtifactStatus: "current",
      auditResultReady: true,
      implementTaskStatus: "completed",
      baseIsAncestor: true,
      hasCommitsSinceBase: true,
      worktreeExists: true,
      trackedClean: true,
      currentHeadSha: "head",
    },
  );

  assert.equal(action.kind, "audit_once");
  if (action.kind === "audit_once") {
    assert.equal(action.recovery, "retry_validation_only_rework");
  }
});

test("validation-only rework stays blocked if HEAD changed", () => {
  const action = reconcileJob(
    job({
      state: "blocked",
      implementer_task_id: "task-rework",
      audit_round: 1,
      audit_head_sha: "audited-head",
      head_sha: "audited-head",
      last_error: "rework produced no commits after audited HEAD",
    }),
    {
      auditArtifactStatus: "current",
      implementTaskStatus: "completed",
      baseIsAncestor: true,
      hasCommitsSinceBase: true,
      trackedClean: true,
      currentHeadSha: "changed-head",
    },
  );

  assert.equal(action.kind, "blocked");
});

test("timed-out zero-commit rework requires explicit recovery and a stale failed task", () => {
  const action = reconcileJob(
    job({
      state: "blocked",
      implementer_task_id: "task-rework",
      implementer_dispatch_id: "dispatch-rework",
      audit_round: 1,
      audit_head_sha: "audited-head",
      head_sha: "audited-head",
      last_error:
        "timeout waiting for worker_done on task task-rework; " +
        REWORK_NO_COMMITS_AFTER_AUDITED_HEAD_ERROR,
    }),
    {
      worktreeExists: true,
      currentHeadSha: "audited-head",
      hasCommitsSinceBase: true,
      baseIsAncestor: true,
      trackedClean: true,
      auditArtifactStatus: "current",
      auditResultReady: true,
      implementTaskStatus: "failed",
    },
  );

  assert.equal(action.kind, "audit_once");
  if (action.kind === "audit_once") {
    assert.equal(action.recovery, "retry_stuck_rework");
  }
  assert.equal(classifyRecoverExecution(action, "blocked"), "explicit_recovery");
});

test("timed-out rework recovery stays blocked unless its stale task and provenance are verified", () => {
  for (const hints of [
    { implementTaskStatus: "working" },
    { implementTaskStatus: "completed" },
    { implementTaskStatus: "failed", trackedClean: false },
    { implementTaskStatus: "failed", currentHeadSha: "different-head" },
    {
      implementTaskStatus: "failed",
      auditArtifactStatus: "stale" as const,
      auditResultReady: false,
    },
  ]) {
    const action = reconcileJob(
      job({
        state: "blocked",
        implementer_task_id: "task-rework",
        implementer_dispatch_id: "dispatch-rework",
        audit_round: 1,
        audit_head_sha: "audited-head",
        head_sha: "audited-head",
        last_error:
          "timeout waiting for worker_done on task task-rework; " +
          REWORK_NO_COMMITS_AFTER_AUDITED_HEAD_ERROR,
      }),
      {
        worktreeExists: true,
        currentHeadSha: "audited-head",
        hasCommitsSinceBase: true,
        baseIsAncestor: true,
        trackedClean: true,
        auditArtifactStatus: "current",
        auditResultReady: true,
        ...hints,
      },
    );
    assert.equal(action.kind, "blocked");
  }

  const missingDispatch = reconcileJob(
    job({
      state: "blocked",
      implementer_task_id: "task-rework",
      implementer_dispatch_id: null,
      audit_round: 1,
      audit_head_sha: "audited-head",
      head_sha: "audited-head",
      last_error:
        "timeout waiting for worker_done on task task-rework; " +
        REWORK_NO_COMMITS_AFTER_AUDITED_HEAD_ERROR,
    }),
    {
      worktreeExists: true,
      currentHeadSha: "audited-head",
      hasCommitsSinceBase: true,
      baseIsAncestor: true,
      trackedClean: true,
      auditArtifactStatus: "current",
      auditResultReady: true,
      implementTaskStatus: "failed",
    },
  );
  assert.equal(missingDispatch.kind, "blocked");
});

test("blocked audit wait resumes when completed evidence is ready", () => {
  const a = reconcileJob(
    job({
      state: "blocked",
      auditor_task_id: "task-audit",
      audit_round: 1,
      audit_head_sha: "head",
      head_sha: "head",
      last_error:
        "worker raised decision_gate (unsupported in M2 auto path)",
    }),
    {
      auditResultReady: true,
      auditTaskStatus: "completed",
      baseIsAncestor: true,
      trackedClean: true,
      currentHeadSha: "head",
    },
  );

  assert.equal(a.kind, "audit_once");
});

test("timed-out audit wait resumes when completed evidence is ready", () => {
  const a = reconcileJob(
    job({
      state: "blocked",
      auditor_task_id: "task-audit",
      audit_round: 1,
      audit_head_sha: "head",
      head_sha: "head",
      last_error: "timeout waiting for worker_done on task task-audit",
    }),
    {
      auditResultReady: true,
      auditTaskStatus: "completed",
      baseIsAncestor: true,
      trackedClean: true,
      currentHeadSha: "head",
    },
  );

  assert.equal(a.kind, "audit_once");
});

test("blocked audit wait stays blocked when completed evidence is incomplete", () => {
  const a = reconcileJob(
    job({
      state: "blocked",
      auditor_task_id: "task-audit",
      last_error:
        "worker raised decision_gate (unsupported in M2 auto path)",
    }),
    {
      auditResultReady: true,
      auditTaskStatus: "running",
      trackedClean: true,
    },
  );

  assert.equal(a.kind, "blocked");
});

test("blocked audit wait stays blocked without same-round HEAD provenance", () => {
  const a = reconcileJob(
    job({
      state: "blocked",
      auditor_task_id: "task-audit",
      last_error: "timeout waiting for worker_done on task task-audit",
    }),
    {
      auditResultReady: true,
      auditTaskStatus: "completed",
      trackedClean: true,
    },
  );

  assert.equal(a.kind, "blocked");
});

test("recovery invariants are documented", () => {
  const inv = recoveryInvariants();
  assert.ok(inv.some((s) => s.includes("never claim a second")));
  assert.ok(inv.some((s) => s.includes("never create a second PR")));
  assert.ok(inv.some((s) => s.includes("never skip audit")));
  assert.ok(inv.some((s) => s.includes("descend from the pinned base")));
  assert.ok(
    inv.some(
      (s) =>
        s.includes("timed-out rework") &&
        s.includes("failed task") &&
        s.includes("audited fixed point"),
    ),
  );
});
