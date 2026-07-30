import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cancelJob, cleanupJobs, reopenAuditFailure } from "../src/lifecycle.js";
import { Ledger } from "../src/ledger.js";
import { testProject } from "./support.js";

test("cancel is dry-run by default, requires a reason to execute, and is idempotent", (t) => {
  const fixture = makeFixture();
  t.after(fixture.dispose);

  const plan = cancelJob({
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
    reason: "issue closed",
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.items[0]?.executed, false);
  assert.equal(fixture.job().state, "blocked");

  const refused = cancelJob({
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
    dryRun: false,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /requires a non-empty --reason/);

  const applied = cancelJob({
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
    reason: "issue closed",
    dryRun: false,
  });
  assert.equal(applied.ok, true);
  assert.equal(fixture.job().state, "cancelled");
  assert.equal(fixture.job().last_error, "cancelled: issue closed");

  const again = cancelJob({
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
    jobId: "job-1",
    reason: "issue closed",
    dryRun: false,
  });
  assert.equal(again.ok, true);
  assert.match(again.message, /already cancelled/);
});

test("cleanup refuses untracked files and preserves the branch on successful removal", (t) => {
  const fixture = makeFixture();
  t.after(fixture.dispose);
  cancelJob({
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
    reason: "done",
    dryRun: false,
  });

  writeFileSync(join(fixture.worktree, "untracked.txt"), "keep me\n");
  const dirty = cleanupJobs({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
    jobId: "job-1",
  });
  assert.equal(dirty.ok, false);
  assert.match(dirty.items[0]?.message ?? "", /worktree is dirty/);

  rmSync(join(fixture.worktree, "untracked.txt"));
  const cleaned = cleanupJobs({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
    jobId: "job-1",
    dryRun: false,
  });
  assert.equal(cleaned.ok, true, cleaned.message);
  assert.equal(cleaned.items[0]?.action, "remove_worktree");
  assert.equal(cleaned.items[0]?.branch, "agent/issue-1");
  assert.equal(fixture.job().worktree_id, null);
  assert.equal(fixture.job().worktree_path, null);
  assert.deepEqual(JSON.parse(readFileSync(fixture.callsPath, "utf8")), [
    "worktree",
    "rm",
    "--worktree",
    "id:repo-1::/tmp/issue-1",
    "--force",
    "--json",
  ]);
});

test("reopen requires an explicit reason and repeats the final audit round after rework", (t) => {
  const fixture = makeFixture();
  t.after(fixture.dispose);
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-1", {
    audit_round: 3,
    audit_head_sha: fixture.job().head_sha,
    audit_result_json: JSON.stringify({ status: "fail" }),
  });
  ledger.close();

  const preview = reopenAuditFailure({ ledgerPath: fixture.ledgerPath, lockPath: fixture.lockPath });
  assert.equal(preview.ok, true);
  assert.equal(preview.items[0]?.executed, false);
  const refused = reopenAuditFailure({ ledgerPath: fixture.ledgerPath, lockPath: fixture.lockPath, dryRun: false });
  assert.equal(refused.ok, false);
  const applied = reopenAuditFailure({ ledgerPath: fixture.ledgerPath, lockPath: fixture.lockPath, dryRun: false, reason: "addressed formula bypasses" });
  assert.equal(applied.ok, true);
  assert.equal(fixture.job().state, "reworking");
  assert.equal(fixture.job().audit_round, 2);
  assert.equal(fixture.job().implementer_task_id, null);
});

test("reopen skips rework when a clean committed descendant already addresses the audit", (t) => {
  const fixture = makeFixture();
  t.after(fixture.dispose);
  const auditedHead = fixture.job().head_sha;
  writeFileSync(join(fixture.worktree, "file.txt"), "post-audit fix\n");
  git(fixture.worktree, "add", "file.txt");
  git(fixture.worktree, "commit", "-m", "post-audit fix");
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-1", {
    audit_round: 3,
    audit_head_sha: auditedHead,
    audit_result_json: JSON.stringify({ status: "fail" }),
  });
  ledger.close();

  const applied = reopenAuditFailure({ ledgerPath: fixture.ledgerPath, lockPath: fixture.lockPath, dryRun: false, reason: "committed fix" });
  assert.equal(applied.ok, true);
  assert.equal(fixture.job().state, "awaiting_audit");
  assert.notEqual(fixture.job().head_sha, auditedHead);
});

test("reopen refuses a failed audit that is not the configured final round", (t) => {
  const fixture = makeFixture();
  t.after(fixture.dispose);
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-1", { audit_round: 2, audit_head_sha: fixture.job().head_sha, audit_result_json: JSON.stringify({ status: "fail" }) });
  ledger.close();
  const result = reopenAuditFailure({ configPath: fixture.configPath, ledgerPath: fixture.ledgerPath, lockPath: fixture.lockPath });
  assert.equal(result.ok, false);
  assert.match(result.message, /final failed audit evidence/);
});

function makeFixture(): {
  ledgerPath: string;
  lockPath: string;
  configPath: string;
  callsPath: string;
  worktree: string;
  job: () => NonNullable<ReturnType<Ledger["getJob"]>>;
  dispose: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "harness-lifecycle-"));
  const worktree = join(dir, "issue-1");
  mkdirSync(worktree);
  git(worktree, "init", "-b", "agent/issue-1");
  git(worktree, "config", "user.name", "Harness Test");
  git(worktree, "config", "user.email", "harness@example.test");
  writeFileSync(join(worktree, "file.txt"), "base\n");
  git(worktree, "add", "file.txt");
  git(worktree, "commit", "-m", "base");
  const baseSha = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "file.txt"), "change\n");
  git(worktree, "add", "file.txt");
  git(worktree, "commit", "-m", "change");
  const headSha = git(worktree, "rev-parse", "HEAD");

  const ledgerPath = join(dir, "ledger.sqlite");
  const ledger = new Ledger(ledgerPath);
  const project = testProject("owner/repo");
  project.localPath = worktree;
  project.orcaRepoId = "repo-1";
  const claim = ledger.tryClaim({
    id: "job-1",
    project,
    issue: {
      number: 1,
      title: "Lifecycle",
      url: "https://example.test/issues/1",
      updatedAt: "2026-07-29T00:00:00Z",
      blockedBy: [],
      labels: ["ready-for-agent"],
    },
    baseRef: "origin/main",
    baseSha,
    implementerProfileId: "pi-implementer",
  });
  assert.equal(claim.ok, true);
  ledger.updateJob("job-1", {
    state: "blocked",
    branch: "agent/issue-1",
    worktree_id: "repo-1::/tmp/issue-1",
    worktree_path: worktree,
    head_sha: headSha,
    last_error: "worker sent escalation",
  });
  ledger.close();

  const callsPath = join(dir, "orca-call.json");
  const fakeOrca = join(dir, "orca.cjs");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args));
console.log(JSON.stringify({ ok: true, result: {} }));
`,
  );
  chmodSync(fakeOrca, 0o755);
  const configPath = join(dir, "harness.yaml");
  writeFileSync(
    configPath,
    `version: 1
issueLabel: ready-for-agent
orca:
  cliPath: ${JSON.stringify(fakeOrca)}
  cliPathFallback: ${JSON.stringify(fakeOrca)}
  controllerTitle: test-controller
activeProfiles:
  implementer: pi-implementer
  auditor: pi-reviewer
agentProfiles:
  pi-implementer:
    id: pi-implementer
    role: implementer
    runtime: orca
    orcaAgent: pi
    invokeHint: implement
  pi-reviewer:
    id: pi-reviewer
    role: auditor
    runtime: orca
    orcaAgent: pi
    readonly: true
    invokeHint: audit
repositories: []
`,
  );

  return {
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
    configPath,
    callsPath,
    worktree,
    job: () => {
      const reopened = new Ledger(ledgerPath);
      try {
        return reopened.getJob("job-1")!;
      } finally {
        reopened.close();
      }
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
