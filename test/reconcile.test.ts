import test from "node:test";
import assert from "node:assert/strict";
import { reconcileJob, recoveryInvariants } from "../src/reconcile.js";
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

test("implementing with commits → run_once finalize path", () => {
  const a = reconcileJob(job({ state: "implementing" }), {
    hasCommitsSinceBase: true,
    trackedClean: true,
  });
  assert.equal(a.kind, "run_once");
  assert.match(a.reason, /commits/i);
});

test("awaiting_audit → audit_once", () => {
  assert.equal(reconcileJob(job({ state: "awaiting_audit" })).kind, "audit_once");
});

test("auditing with result file → audit_once", () => {
  const a = reconcileJob(job({ state: "auditing" }), { auditResultReady: true });
  assert.equal(a.kind, "audit_once");
});

test("audit_passed → publish_once", () => {
  assert.equal(reconcileJob(job({ state: "audit_passed" })).kind, "publish_once");
});

test("publishing with existing PR → publish_once (ensure, not create)", () => {
  const a = reconcileJob(job({ state: "publishing" }), { prExists: true });
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

test("recovery invariants are documented", () => {
  const inv = recoveryInvariants();
  assert.ok(inv.some((s) => s.includes("never claim a second")));
  assert.ok(inv.some((s) => s.includes("never create a second PR")));
  assert.ok(inv.some((s) => s.includes("never skip audit")));
});
