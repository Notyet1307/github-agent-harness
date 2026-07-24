import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.js";
import type { IssueCandidate } from "../src/types.js";

function issue(n: number): IssueCandidate {
  return {
    number: n,
    title: `Issue ${n}`,
    url: `https://example/${n}`,
    updatedAt: new Date().toISOString(),
    blockedBy: [],
    labels: ["ready-for-agent"],
  };
}

test("single-slot: second claim fails while active job exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ledger-"));
  const path = join(dir, "t.sqlite");
  const ledger = new Ledger(path);
  try {
    const a = ledger.tryClaim({
      id: "job-a",
      repo: "o/r",
      issue: issue(1),
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    });
    assert.equal(a.ok, true);
    if (a.ok) {
      assert.equal(a.job.dispatch_attempt, 0);
      assert.equal(a.job.dispatch_probe_pending, 0);
    }

    const b = ledger.tryClaim({
      id: "job-b",
      repo: "o/r",
      issue: issue(2),
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    });
    assert.equal(b.ok, false);
    if (!b.ok) assert.match(b.error, /active job/);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same issue cannot be double-claimed while active", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ledger-"));
  const path = join(dir, "t.sqlite");
  const ledger = new Ledger(path);
  try {
    const a = ledger.tryClaim({
      id: "job-a",
      repo: "o/r",
      issue: issue(1),
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    });
    assert.equal(a.ok, true);

    const again = ledger.tryClaim({
      id: "job-a2",
      repo: "o/r",
      issue: issue(1),
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    });
    assert.equal(again.ok, false);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after merged, same issue can be re-claimed (new attempt)", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ledger-"));
  const path = join(dir, "t.sqlite");
  const ledger = new Ledger(path);
  try {
    const a = ledger.tryClaim({
      id: "job-a",
      repo: "o/r",
      issue: issue(1),
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    });
    assert.equal(a.ok, true);
    ledger.updateJob("job-a", {
      auditor_profile_id: "pi-reviewer",
      auditor_terminal_handle: "auditor-old",
      auditor_task_id: "task-old",
      auditor_dispatch_id: "dispatch-old",
      audit_head_sha: "a".repeat(40),
      dispatch_attempt: 2,
      dispatch_probe_pending: 1,
    });
    ledger.updateJob("job-a", { state: "merged", merged_at: new Date().toISOString() });

    const b = ledger.tryClaim({
      id: "job-b",
      repo: "o/r",
      issue: issue(1),
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    });
    assert.equal(b.ok, true);
    if (b.ok) {
      assert.equal(b.job.state, "claimed");
      assert.equal(b.job.auditor_profile_id, null);
      assert.equal(b.job.auditor_terminal_handle, null);
      assert.equal(b.job.auditor_task_id, null);
      assert.equal(b.job.auditor_dispatch_id, null);
      assert.equal(b.job.audit_head_sha, null);
      assert.equal(b.job.dispatch_attempt, 0);
      assert.equal(b.job.dispatch_probe_pending, 0);
    }
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasActiveJob false after merged", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ledger-"));
  const path = join(dir, "t.sqlite");
  const ledger = new Ledger(path);
  try {
    ledger.tryClaim({
      id: "job-a",
      repo: "o/r",
      issue: issue(1),
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    });
    assert.equal(ledger.hasActiveJob(), true);
    ledger.updateJob("job-a", { state: "merged", merged_at: "t" });
    assert.equal(ledger.hasActiveJob(), false);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
