import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "../src/ledger.js";

function createVersionZeroLedger(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      issue_url TEXT NOT NULL,
      issue_updated_at TEXT NOT NULL,
      issue_snapshot_json TEXT NOT NULL,
      state TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      base_sha TEXT,
      branch TEXT,
      worktree_id TEXT,
      worktree_path TEXT,
      implementer_profile_id TEXT,
      implementer_terminal_handle TEXT,
      implementer_task_id TEXT,
      implementer_dispatch_id TEXT,
      controller_terminal_handle TEXT,
      audit_round INTEGER NOT NULL DEFAULT 0,
      audit_result_json TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      merged_at TEXT,
      last_error TEXT,
      head_sha TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      auditor_profile_id TEXT,
      auditor_terminal_handle TEXT,
      auditor_task_id TEXT,
      auditor_dispatch_id TEXT,
      audit_head_sha TEXT,
      dispatch_attempt INTEGER NOT NULL DEFAULT 0,
      dispatch_probe_pending INTEGER NOT NULL DEFAULT 0,
      UNIQUE(repo, issue_number)
    );
    CREATE INDEX idx_jobs_state ON jobs(state);
    INSERT INTO jobs (
      id, repo, issue_number, issue_url, issue_updated_at,
      issue_snapshot_json, state, base_ref, created_at, updated_at
    ) VALUES (
      'legacy-job', 'owner/repo', 7, 'https://example.test/issues/7',
      '2026-07-26T00:00:00Z', '{}', 'awaiting_audit', 'origin/main',
      '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'
    );
  `);
  db.close();
}

test("opening a version-zero ledger preserves jobs and upgrades project snapshot columns", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ledger-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite");
  createVersionZeroLedger(path);

  const ledger = new Ledger(path);
  t.after(() => ledger.close());

  const job = ledger.getJob("legacy-job");
  assert.equal(job?.state, "awaiting_audit");
  assert.equal(job?.project_key, null);
  assert.equal(job?.project_revision, null);
  assert.equal(job?.project_snapshot_json, null);

  const inspection = new DatabaseSync(path, { readOnly: true });
  t.after(() => inspection.close());
  const version = inspection.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  assert.equal(version.user_version, 3);
  assert.equal(job?.intervention_json, null);
  assert.equal(job?.intervention_resolved_at, null);
  const notificationTable = inspection
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'notification_deliveries'`,
    )
    .get() as { name: string } | undefined;
  assert.equal(notificationTable?.name, "notification_deliveries");
});

test("opening an upgraded ledger repeatedly is idempotent", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ledger-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite");
  createVersionZeroLedger(path);

  new Ledger(path).close();
  const reopened = new Ledger(path);
  t.after(() => reopened.close());

  const job = reopened.getJob("legacy-job");
  assert.equal(job?.state, "awaiting_audit");
  assert.equal(job?.project_snapshot_json, null);
});

test("opening a version-one ledger adds intervention provenance columns", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-ledger-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite");
  createVersionZeroLedger(path);
  const old = new DatabaseSync(path);
  old.exec("PRAGMA user_version = 1");
  old.close();

  const ledger = new Ledger(path);
  t.after(() => ledger.close());
  assert.equal(ledger.getJob("legacy-job")?.intervention_json, null);

  const inspection = new DatabaseSync(path, { readOnly: true });
  t.after(() => inspection.close());
  const columns = inspection.prepare("PRAGMA table_info(jobs)").all() as Array<{
    name: string;
  }>;
  assert.ok(columns.some((column) => column.name === "intervention_json"));
  assert.ok(
    columns.some((column) => column.name === "intervention_resolved_at"),
  );
});
