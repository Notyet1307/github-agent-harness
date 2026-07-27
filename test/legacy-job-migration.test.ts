import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "../src/ledger.js";
import { testProject } from "./support.js";

function createLegacyActiveJob(path: string): void {
  const ledger = new Ledger(path);
  const claimed = ledger.tryClaim({
    id: "legacy-job",
    project: testProject("Owner/Repo"),
    issue: {
      number: 31,
      title: "Legacy project binding",
      url: "https://example.test/issues/31",
      updatedAt: "2026-07-27T00:00:00Z",
      blockedBy: [],
      labels: ["ready-for-agent"],
    },
    baseSha: "a".repeat(40),
    implementerProfileId: "codex-default",
  });
  assert.equal(claimed.ok, true);
  ledger.close();

  const db = new DatabaseSync(path);
  db.prepare(
    `UPDATE jobs
     SET project_key = NULL,
         project_revision = NULL,
         project_snapshot_json = NULL
     WHERE id = 'legacy-job'`,
  ).run();
  db.close();
}

test("resolveJobProject backfills a legacy active job from one matching config entry", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-legacy-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite");
  createLegacyActiveJob(path);
  const ledger = new Ledger(path);
  t.after(() => ledger.close());

  const result = ledger.resolveJobProject("legacy-job", [
    testProject("Owner/Repo"),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source, "backfilled");
  assert.equal(result.project.github, "owner/repo");
  assert.equal(result.job.project_key, "owner/repo");
  assert.ok(result.job.project_revision);
  assert.ok(result.job.project_snapshot_json);
  assert.equal(result.job.revision, 1);
});

test("legacy project resolution fails closed without a matching config entry", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-legacy-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite");
  createLegacyActiveJob(path);
  const ledger = new Ledger(path);
  t.after(() => ledger.close());

  const result = ledger.resolveJobProject("legacy-job", []);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /does not uniquely match config \(0 matches\)/);
  assert.equal(ledger.getJob("legacy-job")?.project_snapshot_json, null);
});

test("legacy project resolution fails closed on ambiguous config entries", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-legacy-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite");
  createLegacyActiveJob(path);
  const ledger = new Ledger(path);
  t.after(() => ledger.close());

  const result = ledger.resolveJobProject("legacy-job", [
    testProject("Owner/Repo"),
    testProject("owner/repo"),
  ]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /does not uniquely match config \(2 matches\)/);
  assert.equal(ledger.getJob("legacy-job")?.project_snapshot_json, null);
});

test("legacy project resolution rejects a changed base ref", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-legacy-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite");
  createLegacyActiveJob(path);
  const ledger = new Ledger(path);
  t.after(() => ledger.close());

  const result = ledger.resolveJobProject("legacy-job", [
    { ...testProject("Owner/Repo"), baseRef: "origin/release" },
  ]);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /does not uniquely match config \(0 matches\)/);
  assert.equal(ledger.getJob("legacy-job")?.project_snapshot_json, null);
});

test("read-only project resolution does not backfill a legacy job", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-legacy-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite");
  createLegacyActiveJob(path);
  const ledger = new Ledger(path);
  t.after(() => ledger.close());

  const result = ledger.resolveJobProject(
    "legacy-job",
    [testProject("Owner/Repo")],
    "read_only",
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source, "legacy");
  assert.equal(result.job.project_snapshot_json, null);
  assert.equal(ledger.getJob("legacy-job")?.project_snapshot_json, null);
  assert.equal(ledger.getJob("legacy-job")?.revision, 0);
});

test("resolveJobProject uses the claimed snapshot after config removal", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-snapshot-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite");
  const ledger = new Ledger(path);
  t.after(() => ledger.close());
  const claimed = ledger.tryClaim({
    id: "snapshotted-job",
    project: testProject("Owner/Repo"),
    issue: {
      number: 32,
      title: "Stable project binding",
      url: "https://example.test/issues/32",
      updatedAt: "2026-07-27T00:00:00Z",
      blockedBy: [],
      labels: ["ready-for-agent"],
    },
    baseSha: "b".repeat(40),
    implementerProfileId: "codex-default",
  });
  assert.equal(claimed.ok, true);

  const result = ledger.resolveJobProject("snapshotted-job", []);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source, "snapshot");
  assert.equal(result.project.github, "owner/repo");
  assert.equal(result.project.localPath, "/tmp/project");
  assert.equal(result.job.revision, 0);
});
