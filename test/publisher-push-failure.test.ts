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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { which } from "../src/exec.js";
import { Ledger } from "../src/ledger.js";
import { publishOnce } from "../src/publisher.js";
import type { IssueCandidate, RepoConfig } from "../src/types.js";

test("publish blocks a permanent git push failure immediately", (t) => {
  const fixture = createPublishFixture(
    "remote: Permission to owner/repo.git denied to bot.",
  );
  t.after(fixture.cleanup);

  const result = fixture.publish();

  assert.equal(result.ok, false);
  assert.match(result.message, /git push failed \[permanent\]/);
  assert.equal(fixture.job()?.state, "blocked");
});

test("publish retries transient git push failures at most three times", (t) => {
  const fixture = createPublishFixture(
    "fatal: unable to access repo: Could not resolve host: github.com",
  );
  t.after(fixture.cleanup);

  assert.equal(fixture.publish().ok, false);
  assert.equal(fixture.job()?.state, "audit_passed");
  assert.match(fixture.job()?.last_error ?? "", /transient 1\/3/);

  assert.equal(fixture.publish().ok, false);
  assert.equal(fixture.job()?.state, "audit_passed");
  assert.match(fixture.job()?.last_error ?? "", /transient 2\/3/);

  assert.equal(fixture.publish().ok, false);
  assert.equal(fixture.job()?.state, "blocked");
  assert.match(fixture.job()?.last_error ?? "", /transient 3\/3/);
});

function createPublishFixture(pushError: string): {
  publish: () => ReturnType<typeof publishOnce>;
  job: () => ReturnType<Ledger["getJob"]>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "publisher-push-failure-"));
  const worktree = join(dir, "worktree");
  const binDir = join(dir, "bin");
  mkdirSync(worktree);
  mkdirSync(binDir);

  git(worktree, "init", "-b", "main");
  git(worktree, "config", "user.name", "Harness Test");
  git(worktree, "config", "user.email", "harness@example.test");
  git(
    worktree,
    "remote",
    "add",
    "origin",
    "https://github.com/owner/repo.git",
  );
  writeFileSync(join(worktree, "value.txt"), "base\n");
  git(worktree, "add", "value.txt");
  git(worktree, "commit", "-m", "base");
  const baseSha = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "value.txt"), "head\n");
  git(worktree, "add", "value.txt");
  git(worktree, "commit", "-m", "head");
  const headSha = git(worktree, "rev-parse", "HEAD");

  const realGit = which("git");
  assert.ok(realGit, "git must be available for the integration fixture");
  const fakeGit = join(binDir, "git");
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("push")) {
  process.stderr.write(${JSON.stringify(pushError)} + "\\n");
  process.exit(1);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
  );
  chmodSync(fakeGit, 0o755);

  const fakeGh = join(binDir, "gh");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 20,
    title: "Test publish",
    url: "https://example.test/issues/20",
    updatedAt: "2026-07-29T00:00:00Z",
    state: "OPEN",
    labels: ["ready-for-agent"],
    blockedBy: [],
    subIssues: [],
    assignees: []
  }));
} else {
  process.stderr.write("unexpected gh call: " + args.join(" "));
  process.exitCode = 1;
}
`,
  );
  chmodSync(fakeGh, 0o755);

  const fakeOrca = join(binDir, "orca");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
const key = args.slice(0, 2).join(" ");
if (args[0] === "status") {
  console.log(JSON.stringify({ ok: true, result: {
    app: { running: true }, runtime: { state: "ready", reachable: true }
  } }));
} else if (key === "repo list") {
  console.log(JSON.stringify({ ok: true, result: { repos: [{
    id: "repo-1",
    path: ${JSON.stringify(worktree)},
    worktreeBaseRef: "origin/main",
    gitRemoteIdentity: { canonicalKey: "owner/repo" }
  }] } }));
} else if (key === "repo show") {
  console.log(JSON.stringify({ ok: true, result: { repo: {
    id: "repo-1",
    path: ${JSON.stringify(worktree)},
    worktreeBaseRef: "origin/main",
    gitRemoteIdentity: { canonicalKey: "owner/repo" }
  } } }));
} else if (key === "worktree set") {
  console.log(JSON.stringify({ ok: true, result: {} }));
} else {
  console.log(JSON.stringify({ ok: false, error: { message: "unexpected " + key } }));
  process.exitCode = 1;
}
`,
  );
  chmodSync(fakeOrca, 0o755);

  const project: RepoConfig = {
    github: "owner/repo",
    localPath: worktree,
    baseRef: "origin/main",
    defaultBranch: "main",
    orcaRepoId: "repo-1",
  };
  const issue: IssueCandidate = {
    number: 20,
    title: "Test publish",
    url: "https://example.test/issues/20",
    updatedAt: "2026-07-29T00:00:00Z",
    blockedBy: [],
    labels: ["ready-for-agent"],
  };
  const ledgerPath = join(dir, "ledger.sqlite");
  const ledger = new Ledger(ledgerPath);
  const claimed = ledger.tryClaim({
    id: "publish-job",
    project,
    issue,
    baseSha,
    implementerProfileId: "pi-implementer",
  });
  assert.equal(claimed.ok, true);
  ledger.updateJob("publish-job", {
    state: "audit_passed",
    branch: "agent/issue-20",
    worktree_id: "worktree-1",
    worktree_path: worktree,
    head_sha: headSha,
  });
  ledger.close();

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
repositories:
  - github: owner/repo
    localPath: ${JSON.stringify(worktree)}
    orcaRepoId: repo-1
    baseRef: origin/main
    defaultBranch: main
`,
  );

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  return {
    publish: () =>
      publishOnce({
        configPath,
        ledgerPath,
        lockPath: join(dir, "harness.lock"),
      }),
    job: () => {
      const reopened = new Ledger(ledgerPath);
      try {
        return reopened.getJob("publish-job");
      } finally {
        reopened.close();
      }
    },
    cleanup: () => {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
