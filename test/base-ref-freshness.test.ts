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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshBaseRef } from "../src/git.js";
import { runOnce } from "../src/run-once.js";
import { Ledger } from "../src/ledger.js";

test("refreshBaseRef updates a stale remote-tracking ref", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "base-ref-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const remote = join(dir, "remote.git");
  git(dir, "init", "--bare", remote);

  const author = join(dir, "author");
  mkdirSync(author);
  git(author, "init", "-b", "main");
  git(author, "config", "user.name", "Harness Test");
  git(author, "config", "user.email", "harness@example.test");
  writeFileSync(join(author, "value.txt"), "one\n");
  git(author, "add", "value.txt");
  git(author, "commit", "-m", "one");
  git(author, "remote", "add", "origin", remote);
  git(author, "push", "-u", "origin", "main");
  git(author, "checkout", "-b", "maintenance");
  git(author, "push", "-u", "origin", "maintenance");
  git(author, "checkout", "main");

  const consumer = join(dir, "consumer");
  git(dir, "clone", remote, consumer);
  git(
    consumer,
    "config",
    "--replace-all",
    "remote.origin.fetch",
    "+refs/heads/maintenance:refs/remotes/origin/maintenance",
  );
  const staleSha = git(consumer, "rev-parse", "origin/main");
  git(consumer, "branch", "origin/main", staleSha);

  writeFileSync(join(author, "value.txt"), "two\n");
  git(author, "add", "value.txt");
  git(author, "commit", "-m", "two");
  git(author, "push", "origin", "main");
  const latestSha = git(author, "rev-parse", "HEAD");
  assert.notEqual(staleSha, latestSha);

  const refreshed = refreshBaseRef(consumer, "origin/main");

  assert.deepEqual(refreshed, { ok: true, sha: latestSha });
  assert.equal(
    git(consumer, "rev-parse", "refs/remotes/origin/main"),
    latestSha,
  );
});

test("runOnce blocks a worktree created from a different base SHA", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "run-once-base-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const remote = join(dir, "remote.git");
  git(dir, "init", "--bare", remote);

  const author = join(dir, "author");
  mkdirSync(author);
  git(author, "init", "-b", "main");
  git(author, "config", "user.name", "Harness Test");
  git(author, "config", "user.email", "harness@example.test");
  writeFileSync(join(author, "value.txt"), "old\n");
  git(author, "add", "value.txt");
  git(author, "commit", "-m", "old");
  git(author, "remote", "add", "origin", remote);
  git(author, "push", "-u", "origin", "main");

  const repo = join(dir, "repo");
  const staleWorktree = join(dir, "stale-worktree");
  git(dir, "clone", remote, repo);
  git(dir, "clone", remote, staleWorktree);
  const staleSha = git(staleWorktree, "rev-parse", "HEAD");

  writeFileSync(join(author, "value.txt"), "new\n");
  git(author, "add", "value.txt");
  git(author, "commit", "-m", "new");
  git(author, "push", "origin", "main");
  const expectedSha = git(author, "rev-parse", "HEAD");
  assert.notEqual(staleSha, expectedSha);

  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const fakeGh = join(binDir, "gh");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const actual = execFileSync("git", ["-C", ${JSON.stringify(repo)}, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
if (actual !== ${JSON.stringify(expectedSha)}) {
  process.stderr.write("base ref was not refreshed before GitHub selection");
  process.exit(1);
}
if (args[0] === "issue" && args[1] === "list") {
  console.log(JSON.stringify([{
    number: 9,
    title: "Base freshness",
    url: "https://example.test/issues/9",
    updatedAt: "2026-07-23T00:00:00Z",
    labels: [{ name: "ready-for-agent" }],
    blockedBy: [],
    state: "OPEN"
  }]));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 9,
    title: "Base freshness",
    url: "https://example.test/issues/9",
    updatedAt: "2026-07-23T00:00:00Z",
    labels: [{ name: "ready-for-agent" }],
    blockedBy: [],
    state: "OPEN"
  }));
} else {
  process.stderr.write("unexpected gh command: " + args.join(" "));
  process.exit(1);
}
`,
  );
  chmodSync(fakeGh, 0o755);

  const fakeOrca = join(dir, "orca.cjs");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
const key = args.slice(0, 2).join(" ");
if (args[0] === "status") {
  console.log(JSON.stringify({ ok: true, result: {
    app: { running: true },
    runtime: { state: "ready", reachable: true }
  } }));
} else if (key === "terminal list" && args.includes(${JSON.stringify(`path:${dir}`)})) {
  console.log(JSON.stringify({ ok: true, result: {
    terminals: [{ handle: "controller-1", title: "test-controller", connected: true }]
  } }));
} else if (key === "worktree list") {
  console.log(JSON.stringify({ ok: true, result: { worktrees: [] } }));
} else if (key === "worktree create") {
  console.log(JSON.stringify({ ok: true, result: {
    worktree: {
      id: "worktree-1",
      path: ${JSON.stringify(staleWorktree)},
      branch: "main"
    }
  } }));
} else if (key === "terminal list") {
  console.log(JSON.stringify({ ok: true, result: { terminals: [] } }));
} else if (key === "terminal create") {
  console.log(JSON.stringify({ ok: true, result: { handle: "codex-1" } }));
} else if (key === "worktree set") {
  console.log(JSON.stringify({ ok: true, result: {} }));
} else {
  console.log(JSON.stringify({ ok: false, error: {
    message: "unexpected " + key
  } }));
  process.exitCode = 1;
}
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
  controllerWorktreePath: ${JSON.stringify(dir)}
  controllerTitle: test-controller
activeProfiles:
  implementer: codex-default
  auditor: pi-reviewer
agentProfiles:
  codex-default:
    id: codex-default
    role: implementer
    runtime: orca
    orcaAgent: codex
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
    localPath: ${JSON.stringify(repo)}
    orcaRepoId: repo-1
    baseRef: origin/main
    defaultBranch: main
`,
  );

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  const ledgerPath = join(dir, "harness.sqlite");
  let result;
  try {
    result = runOnce({
      configPath,
      ledgerPath,
      lockPath: join(dir, "harness.lock"),
    });
  } finally {
    process.env.PATH = originalPath;
  }

  assert.equal(result.ok, false);
  assert.match(result.message, /worktree base SHA mismatch/);
  const ledger = new Ledger(ledgerPath);
  const job = ledger.getActiveJob();
  assert.equal(job?.state, "blocked");
  assert.equal(job?.base_sha, expectedSha);
  assert.equal(job?.worktree_path, staleWorktree);
  ledger.close();
});

test("runOnce blocks incomplete worktree provenance without moving the pinned base", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "run-once-partial-worktree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const remote = join(dir, "remote.git");
  git(dir, "init", "--bare", remote);

  const author = join(dir, "author");
  mkdirSync(author);
  git(author, "init", "-b", "main");
  git(author, "config", "user.name", "Harness Test");
  git(author, "config", "user.email", "harness@example.test");
  writeFileSync(join(author, "value.txt"), "old\n");
  git(author, "add", "value.txt");
  git(author, "commit", "-m", "old");
  git(author, "remote", "add", "origin", remote);
  git(author, "push", "-u", "origin", "main");

  const repo = join(dir, "repo");
  git(dir, "clone", remote, repo);
  const pinnedSha = git(repo, "rev-parse", "origin/main");

  const ledgerPath = join(dir, "harness.sqlite");
  const ledger = new Ledger(ledgerPath);
  const claimed = ledger.tryClaim({
    id: "partial-worktree-job",
    repo: "owner/repo",
    issue: {
      number: 10,
      title: "Partial worktree provenance",
      url: "https://example.test/issues/10",
      updatedAt: "2026-07-23T00:00:00Z",
      labels: ["ready-for-agent"],
      blockedBy: [],
    },
    baseRef: "origin/main",
    implementerProfileId: "codex-default",
  });
  assert.equal(claimed.ok, true);
  ledger.updateJob("partial-worktree-job", {
    base_sha: pinnedSha,
    worktree_id: "worktree-1",
  });
  ledger.close();

  writeFileSync(join(author, "value.txt"), "new\n");
  git(author, "add", "value.txt");
  git(author, "commit", "-m", "new");
  git(author, "push", "origin", "main");
  const latestSha = git(author, "rev-parse", "HEAD");

  const fakeOrca = join(dir, "orca.cjs");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
if (args[0] === "status") {
  console.log(JSON.stringify({ ok: true, result: {
    app: { running: true },
    runtime: { state: "ready", reachable: true }
  } }));
} else {
  console.log(JSON.stringify({ ok: false, error: {
    message: "unexpected Orca call after partial worktree detection"
  } }));
  process.exitCode = 1;
}
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
  controllerWorktreePath: ${JSON.stringify(dir)}
  controllerTitle: test-controller
activeProfiles:
  implementer: codex-default
  auditor: pi-reviewer
agentProfiles:
  codex-default:
    id: codex-default
    role: implementer
    runtime: orca
    orcaAgent: codex
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
    localPath: ${JSON.stringify(repo)}
    orcaRepoId: repo-1
    baseRef: origin/main
    defaultBranch: main
`,
  );

  const result = runOnce({
    configPath,
    ledgerPath,
    lockPath: join(dir, "harness.lock"),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /incomplete worktree provenance/);
  const after = new Ledger(ledgerPath);
  const job = after.getActiveJob();
  assert.equal(job?.state, "blocked");
  assert.equal(job?.base_sha, pinnedSha);
  assert.equal(job?.worktree_id, "worktree-1");
  assert.equal(job?.worktree_path, null);
  after.close();

  const recoveryLedgerPath = join(dir, "recovery.sqlite");
  const recoveryLedger = new Ledger(recoveryLedgerPath);
  const recoveryClaim = recoveryLedger.tryClaim({
    id: "unrecorded-worktree-job",
    repo: "owner/repo",
    issue: {
      number: 11,
      title: "Unrecorded worktree",
      url: "https://example.test/issues/11",
      updatedAt: "2026-07-23T00:00:00Z",
      labels: ["ready-for-agent"],
      blockedBy: [],
    },
    baseRef: "origin/main",
    implementerProfileId: "codex-default",
  });
  assert.equal(recoveryClaim.ok, true);
  recoveryLedger.updateJob("unrecorded-worktree-job", {
    base_sha: pinnedSha,
  });
  recoveryLedger.close();

  runOnce({
    configPath,
    ledgerPath: recoveryLedgerPath,
    lockPath: join(dir, "recovery.lock"),
  });

  const recovered = new Ledger(recoveryLedgerPath);
  assert.equal(recovered.getActiveJob()?.base_sha, pinnedSha);
  assert.equal(
    git(repo, "rev-parse", "refs/remotes/origin/main"),
    pinnedSha,
  );
  assert.notEqual(pinnedSha, latestSha);
  recovered.close();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}
