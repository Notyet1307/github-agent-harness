import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.js";
import { testProject } from "./support.js";
import type { IssueCandidate } from "../src/types.js";

const issue: IssueCandidate = {
  number: 17,
  title: "Pin claim base",
  url: "https://example.test/issues/17",
  updatedAt: "2026-07-26T00:00:00Z",
  blockedBy: [],
  labels: ["ready-for-agent"],
};

test("tryClaim persists the refreshed base SHA with the claim snapshot", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-claim-base-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  t.after(() => ledger.close());

  const result = ledger.tryClaim({
    id: "job-17",
    project: testProject("owner/repo"),
    issue,
    baseRef: "origin/main",
    baseSha: "a".repeat(40),
    implementerProfileId: "codex-default",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.job.state, "claimed");
  assert.equal(result.job.base_ref, "origin/main");
  assert.equal(result.job.base_sha, "a".repeat(40));
  assert.deepEqual(JSON.parse(result.job.issue_snapshot_json), issue);
  assert.equal(ledger.getJob("job-17")?.base_sha, "a".repeat(40));
});

test("tryClaim rejects a claim without a base SHA", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-claim-base-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  t.after(() => ledger.close());

  const result = ledger.tryClaim({
    id: "job-without-base",
    project: testProject("owner/repo"),
    issue,
    baseRef: "origin/main",
    implementerProfileId: "codex-default",
  } as Parameters<Ledger["tryClaim"]>[0]);

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /base sha/i);
  assert.equal(ledger.getActiveJob(), null);
});
