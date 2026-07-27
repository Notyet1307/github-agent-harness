import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.js";
import { validateProjectRuntime } from "../src/project.js";
import { publishOnce } from "../src/publisher.js";
import type { IssueCandidate, RepoConfig } from "../src/types.js";

const project: RepoConfig = {
  github: "Owner/Repo",
  localPath: "/tmp/project",
  baseRef: "origin/main",
  defaultBranch: "main",
  orcaRepoId: "orca-1",
};

const issue: IssueCandidate = {
  number: 23,
  title: "Persist project snapshot",
  url: "https://example.test/issues/23",
  updatedAt: "2026-07-27T00:00:00Z",
  blockedBy: [],
  labels: ["ready-for-agent"],
};

test("tryClaim atomically persists a canonical versioned project snapshot", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-job-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  t.after(() => ledger.close());

  const result = ledger.tryClaim({
    id: "job-23",
    project,
    issue,
    baseSha: "a".repeat(40),
    implementerProfileId: "codex-default",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.job.repo, "owner/repo");
  assert.equal(result.job.base_ref, "origin/main");
  assert.equal(result.job.project_key, "owner/repo");
  assert.equal(
    result.job.project_revision,
    "568336051224fa68a15db487b9f1ae1418d9e59cdd7deccce2b15216af173751",
  );
  assert.deepEqual(JSON.parse(result.job.project_snapshot_json!), {
    version: 1,
    key: "owner/repo",
    github: "owner/repo",
    localPath: "/tmp/project",
    baseRef: "origin/main",
    defaultBranch: "main",
    orcaRepoId: "orca-1",
  });
});

test("resolveJobProject fails closed on incomplete snapshot provenance", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-job-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.sqlite");
  const ledger = new Ledger(ledgerPath);
  const result = ledger.tryClaim({
    id: "job-23",
    project,
    issue,
    baseSha: "a".repeat(40),
    implementerProfileId: "codex-default",
  });
  assert.equal(result.ok, true);
  ledger.close();

  const db = new DatabaseSync(ledgerPath);
  db.prepare(
    "UPDATE jobs SET project_revision = NULL WHERE id = 'job-23'",
  ).run();
  db.close();

  const reopened = new Ledger(ledgerPath);
  t.after(() => reopened.close());
  const resolved = reopened.resolveJobProject("job-23", []);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.error, /incomplete project snapshot provenance/);
});

test("resolveJobProject rejects a tampered snapshot revision", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-job-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.sqlite");
  const ledger = new Ledger(ledgerPath);
  const result = ledger.tryClaim({
    id: "job-23",
    project,
    issue,
    baseSha: "a".repeat(40),
    implementerProfileId: "codex-default",
  });
  assert.equal(result.ok, true);
  ledger.close();

  const db = new DatabaseSync(ledgerPath);
  db.prepare(
    "UPDATE jobs SET project_revision = ? WHERE id = 'job-23'",
  ).run("0".repeat(64));
  db.close();

  const reopened = new Ledger(ledgerPath);
  t.after(() => reopened.close());
  const resolved = reopened.resolveJobProject("job-23", []);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.error, /project snapshot provenance does not match/);
});

test("publishOnce resolves the active project from its snapshot", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-publish-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "harness.yaml");
  const ledgerPath = join(dir, "ledger.sqlite");
  writeFileSync(
    configPath,
    `version: 1
issueLabel: ready-for-agent
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
  const ledger = new Ledger(ledgerPath);
  const claimed = ledger.tryClaim({
    id: "publish-job",
    project,
    issue,
    baseSha: "a".repeat(40),
    implementerProfileId: "pi-implementer",
  });
  assert.equal(claimed.ok, true);
  ledger.updateJob("publish-job", { state: "audit_passed" });
  ledger.close();

  const result = publishOnce({
    configPath,
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /missing worktree\/branch\/base_sha\/head_sha/);
});

test("validateProjectRuntime verifies the claimed path, remote, and Orca binding", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-project-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repoPath = join(dir, "repo");
  mkdirSync(repoPath);
  execFileSync("git", ["init", repoPath]);
  execFileSync("git", [
    "-C",
    repoPath,
    "remote",
    "add",
    "origin",
    "https://github.com/owner/repo.git",
  ]);
  const orca = join(dir, "orca.cjs");
  writeFileSync(
    orca,
    `#!/usr/bin/env node
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
if (args[0] === "repo" && args[1] === "show") {
  console.log(JSON.stringify({ ok: true, result: { repo: {
    id: "orca-1",
    path: ${JSON.stringify(repoPath)},
    worktreeBaseRef: "origin/main",
    gitRemoteIdentity: { canonicalKey: "owner/repo" }
  } } }));
} else {
  console.log(JSON.stringify({ ok: false, error: { message: "unexpected command" } }));
  process.exitCode = 1;
}
`,
  );
  chmodSync(orca, 0o755);

  const result = validateProjectRuntime(
    {
      github: "owner/repo",
      localPath: repoPath,
      baseRef: "origin/main",
      defaultBranch: "main",
      orcaRepoId: "orca-1",
    },
    orca,
  );

  assert.deepEqual(result, { ok: true });

  execFileSync("git", [
    "-C",
    repoPath,
    "remote",
    "set-url",
    "origin",
    "https://github.com/other/repo.git",
  ]);
  const wrongRemote = validateProjectRuntime(
    {
      github: "owner/repo",
      localPath: repoPath,
      baseRef: "origin/main",
      defaultBranch: "main",
      orcaRepoId: "orca-1",
    },
    orca,
  );
  assert.equal(wrongRemote.ok, false);
  if (!wrongRemote.ok) {
    assert.match(wrongRemote.error, /origin does not match snapshot identity/);
  }

  execFileSync("git", [
    "-C",
    repoPath,
    "remote",
    "set-url",
    "origin",
    "https://github.com/owner/repo.git",
  ]);
  writeFileSync(
    orca,
    `#!/usr/bin/env node
console.log(JSON.stringify({ ok: true, result: { repo: {
  id: "orca-1",
  path: ${JSON.stringify(join(dir, "other-repo"))},
  worktreeBaseRef: "origin/main",
  gitRemoteIdentity: { canonicalKey: "owner/repo" }
} } }));
`,
  );
  const wrongOrcaPath = validateProjectRuntime(
    {
      github: "owner/repo",
      localPath: repoPath,
      baseRef: "origin/main",
      defaultBranch: "main",
      orcaRepoId: "orca-1",
    },
    orca,
  );
  assert.equal(wrongOrcaPath.ok, false);
  if (!wrongOrcaPath.ok) {
    assert.match(wrongOrcaPath.error, /Orca repo path .* does not match/);
  }
});
