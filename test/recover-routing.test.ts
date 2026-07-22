import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.js";
import { reconcileJob } from "../src/reconcile.js";

/**
 * Simulate the M5 stage matrix as ledger states + hints
 * (no Orca side effects).
 */
const stages: Array<{
  name: string;
  state: Parameters<typeof reconcileJob>[0] extends infer J
    ? J extends { state: infer S }
      ? S
      : never
    : never;
  hints?: Parameters<typeof reconcileJob>[1];
  expect: string;
}> = [
  { name: "after claim", state: "claimed", expect: "run_once" },
  { name: "worktree ready", state: "worktree_ready", expect: "run_once" },
  {
    name: "codex mid-flight",
    state: "implementing",
    hints: { hasCommitsSinceBase: false },
    expect: "run_once",
  },
  {
    name: "codex done ledger stale",
    state: "implementing",
    hints: { hasCommitsSinceBase: true, trackedClean: true },
    expect: "run_once",
  },
  { name: "ready for pi", state: "awaiting_audit", expect: "audit_once" },
  {
    name: "pi mid / result on disk",
    state: "auditing",
    hints: { auditResultReady: true },
    expect: "audit_once",
  },
  { name: "audit passed", state: "audit_passed", expect: "publish_once" },
  {
    name: "push done PR exists",
    state: "publishing",
    hints: { prExists: true },
    expect: "publish_once",
  },
  {
    name: "pr open",
    state: "awaiting_merge",
    hints: { prExists: true },
    expect: "wait_merge",
  },
  {
    name: "pr merged ledger stale",
    state: "awaiting_merge",
    hints: { prMerged: true },
    expect: "wait_merge",
  },
];

test("M5 stage matrix maps to ensure* actions", () => {
  for (const s of stages) {
    const job = {
      id: "x",
      repo: "o/r",
      issue_number: 1,
      issue_url: "u",
      issue_updated_at: "t",
      issue_snapshot_json: "{}",
      state: s.state as never,
      base_ref: "origin/main",
      base_sha: "b",
      branch: "br",
      worktree_id: "w",
      worktree_path: "/tmp",
      implementer_profile_id: null,
      implementer_terminal_handle: null,
      implementer_task_id: null,
      implementer_dispatch_id: null,
      auditor_profile_id: null,
      auditor_terminal_handle: null,
      auditor_task_id: null,
      auditor_dispatch_id: null,
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
    };
    const action = reconcileJob(job, s.hints ?? {});
    assert.equal(
      action.kind,
      s.expect,
      `${s.name}: expected ${s.expect}, got ${action.kind}`,
    );
  }
});

test("ledger fixture: active implementing blocks new claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-m5-"));
  const dbPath = join(dir, "h.sqlite");
  const ledger = new Ledger(dbPath);
  try {
    const claim = ledger.tryClaim({
      id: "job1",
      repo: "o/r",
      issue: {
        number: 7,
        title: "t",
        url: "u",
        updatedAt: "t",
        blockedBy: [],
        labels: ["ready-for-agent"],
      },
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    });
    assert.equal(claim.ok, true);
    ledger.updateJob("job1", {
      state: "implementing",
      base_sha: "aaa",
      worktree_path: join(dir, "wt"),
    });
    mkdirSync(join(dir, "wt"), { recursive: true });
    writeFileSync(join(dir, "wt", "x"), "1");

    const second = ledger.tryClaim({
      id: "job2",
      repo: "o/r",
      issue: {
        number: 8,
        title: "t2",
        url: "u2",
        updatedAt: "t",
        blockedBy: [],
        labels: ["ready-for-agent"],
      },
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    });
    assert.equal(second.ok, false);
    assert.equal(ledger.hasActiveJob(), true);
    assert.equal(ledger.getActiveJob()?.issue_number, 7);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
