import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.js";
import { testProject } from "./support.js";

function openClaimedLedger(t: test.TestContext): {
  ledger: Ledger;
  path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "harness-ledger-cas-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite");
  const ledger = new Ledger(path);
  t.after(() => ledger.close());
  const claimed = ledger.tryClaim({
    id: "job-1",
    project: testProject("owner/repo"),
    issue: {
      number: 1,
      title: "CAS",
      url: "https://example.test/issues/1",
      updatedAt: "2026-07-26T00:00:00Z",
      blockedBy: [],
      labels: ["ready-for-agent"],
    },
    baseRef: "origin/main",
    baseSha: "a".repeat(40),
    implementerProfileId: "codex-default",
  });
  assert.equal(claimed.ok, true);
  return { ledger, path };
}

test("job revision starts at zero and increments on update", (t) => {
  const { ledger } = openClaimedLedger(t);

  assert.equal(ledger.getJob("job-1")?.revision, 0);
  const updated = ledger.updateJob("job-1", { state: "worktree_ready" });

  assert.equal(updated.revision, 1);
  assert.equal(ledger.getJob("job-1")?.revision, 1);
});

test("updateJobIf does not overwrite a concurrent update", (t) => {
  const { ledger, path } = openClaimedLedger(t);
  const staleRevision = ledger.getJob("job-1")!.revision;
  const concurrent = new Ledger(path);
  t.after(() => concurrent.close());

  concurrent.updateJob("job-1", { state: "implementing" });
  const staleWrite = ledger.updateJobIf("job-1", staleRevision, {
    last_error: "stale result",
  });

  assert.equal(staleWrite, null);
  const current = ledger.getJob("job-1");
  assert.equal(current?.state, "implementing");
  assert.equal(current?.last_error, null);
  assert.equal(current?.revision, staleRevision + 1);
});
