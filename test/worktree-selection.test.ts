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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.js";
import { ensureIssueWorktree } from "../src/orca-runtime.js";
import { runOnce } from "../src/run-once.js";
import type { AgentProfile, RepoConfig } from "../src/types.js";

const repo: RepoConfig = {
  github: "owner/repo",
  localPath: "/tmp/repo",
  orcaRepoId: "repo-1",
  baseRef: "origin/main",
  defaultBranch: "main",
};

const profile: AgentProfile = {
  id: "pi-implementer",
  role: "implementer",
  runtime: "orca",
  orcaAgent: "pi",
  invokeHint: "implement",
};

test("runOnce keeps an Orca worktree list failure retryable", (t) => {
  const fixture = makeRunOnceFixture({
    ok: false,
    error: { message: "runtime unavailable" },
  });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /Orca worktree list.*runtime unavailable/i);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-1")?.state, "claimed");
  verified.close();
  assert.equal(hasCall(fixture.calls(), "worktree", "create"), false);
});

test("runOnce resumes a snapshotted job after its config entry is removed", (t) => {
  const fixture = makeRunOnceFixture(completeList([]));
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-1", { state: "awaiting_audit" });
  ledger.close();
  const config = readFileSync(fixture.configPath, "utf8");
  writeFileSync(
    fixture.configPath,
    config.replace(/repositories:[\s\S]*$/, "repositories: []\n"),
  );

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
  });

  assert.equal(result.ok, true);
  assert.match(result.message, /past implement/);
});

test("runOnce blocks when the snapshotted project path cannot be verified", (t) => {
  const fixture = makeRunOnceFixture(completeList([]));
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-1", { state: "awaiting_audit" });
  ledger.close();
  rmSync(fixture.repoPath, { recursive: true, force: true });

  const result = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /not a readable Git worktree/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-1")?.state, "blocked");
  verified.close();
});

test("selects issue-1 exactly when issue-10 is listed first", (t) => {
  const fake = makeFakeOrca(
    completeList([listedWorktree(10), listedWorktree(1)]),
  );
  t.after(() => rmSync(fake.dir, { recursive: true, force: true }));

  const result = ensureIssueWorktree(fake.command, repo, 1, profile);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.worktreeId, "repo-1::/tmp/issue-1");
    assert.equal(result.value.worktreePath, "/tmp/issue-1");
  }
});

test("blocks when more than one worktree matches the issue", (t) => {
  const fake = makeFakeOrca(
    completeList([
      listedWorktree(1, {
        id: "repo-1::/tmp/issue-1-a",
        path: "/tmp/issue-1-a",
      }),
      listedWorktree(1, {
        id: "repo-1::/tmp/issue-1-b",
        path: "/tmp/issue-1-b",
      }),
    ]),
  );
  t.after(() => rmSync(fake.dir, { recursive: true, force: true }));

  const result = ensureIssueWorktree(fake.command, repo, 1, profile);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /multiple worktrees.*issue #1/i);
    assert.match(result.error, /issue-1-a.*issue-1-b/);
  }
  assert.equal(hasCall(fake.calls(), "terminal"), false);
});

test("blocks incomplete or invalid Orca worktree snapshots", () => {
  const cases: Array<{ response: unknown; error: RegExp }> = [
    {
      response: {
        ok: true,
        result: { worktrees: {}, totalCount: 0, truncated: false },
      },
      error: /invalid worktree list/i,
    },
    {
      response: completeList([{}]),
      error: /invalid worktree list entry/i,
    },
    {
      response: completeList([], { truncated: true }),
      error: /truncated worktree list/i,
    },
    {
      response: { ok: true, result: { worktrees: [] } },
      error: /worktree list completeness/i,
    },
    {
      response: completeList([], { totalCount: 1 }),
      error: /totalCount/i,
    },
  ];

  for (const fixture of cases) {
    const fake = makeFakeOrca(fixture.response);
    try {
      const result = ensureIssueWorktree(fake.command, repo, 1, profile);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, fixture.error);
      assert.equal(hasCall(fake.calls(), "worktree", "create"), false);
      assert.equal(hasCall(fake.calls(), "terminal"), false);
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  }
});

test("runOnce keeps a completed worktree collision blocked", (t) => {
  const fixture = makeRunOnceFixture(
    completeList([
      listedWorktree(1, {
        id: "repo-1::/Users/test/orca/workspaces/issue-1",
        path: "/Users/test/orca/workspaces/issue-1",
        workspaceStatus: "completed",
      }),
    ]),
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const first = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
  });
  const callsAfterFirst = fixture.calls();
  const second = runOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: fixture.lockPath,
  });

  assert.equal(first.ok, false);
  assert.match(first.message, /completed worktree.*issue #1/i);
  assert.equal(second.ok, false);
  assert.match(second.message, /job is blocked/i);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-1")?.state, "blocked");
  verified.close();
  assert.equal(
    fixture.calls().filter(
      (args) => args[0] === "worktree" && args[1] === "list",
    ).length,
    callsAfterFirst.filter(
      (args) => args[0] === "worktree" && args[1] === "list",
    ).length,
  );
  assert.equal(hasCall(callsAfterFirst, "terminal", "create"), false);
});

function listedWorktree(
  issue: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `repo-1::/tmp/issue-${issue}`,
    path: `/tmp/issue-${issue}`,
    displayName: `issue-${issue}`,
    linkedIssue: issue,
    workspaceStatus: "in-progress",
    ...overrides,
  };
}

function completeList(
  worktrees: unknown[],
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    ok: true,
    result: {
      worktrees,
      totalCount: worktrees.length,
      truncated: false,
      ...overrides,
    },
  };
}

function hasCall(calls: string[][], ...prefix: string[]): boolean {
  return calls.some((args) =>
    prefix.every((part, index) => args[index] === part),
  );
}

function makeRunOnceFixture(listResponse: unknown): {
  configPath: string;
  ledgerPath: string;
  lockPath: string;
  dir: string;
  repoPath: string;
  calls: () => string[][];
} {
  const fake = makeFakeOrca(listResponse);
  const configPath = join(fake.dir, "harness.yaml");
  const ledgerPath = join(fake.dir, "harness.sqlite");
  writeFileSync(
    configPath,
    `version: 1
issueLabel: ready-for-agent
orca:
  cliPath: ${JSON.stringify(fake.command)}
  cliPathFallback: ${JSON.stringify(fake.command)}
  controllerTitle: harness-controller
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
    localPath: ${JSON.stringify(fake.repoPath)}
    orcaRepoId: repo-1
    baseRef: origin/main
    defaultBranch: main
`,
  );
  const ledger = new Ledger(ledgerPath);
  const claimed = ledger.tryClaim({
    id: "job-1",
    project: {
      github: "owner/repo",
      localPath: fake.repoPath,
      orcaRepoId: "repo-1",
      baseRef: "origin/main",
      defaultBranch: "main",
    },
    issue: {
      number: 1,
      title: "Issue 1",
      url: "https://example.test/issues/1",
      updatedAt: "2026-07-24T00:00:00Z",
      blockedBy: [],
      labels: ["ready-for-agent"],
    },
    baseRef: "origin/main",
    baseSha: "a".repeat(40),
    implementerProfileId: "pi-implementer",
  });
  assert.equal(claimed.ok, true);
  ledger.close();
  return {
    configPath,
    ledgerPath,
    lockPath: join(fake.dir, "harness.lock"),
    dir: fake.dir,
    repoPath: fake.repoPath,
    calls: fake.calls,
  };
}

function makeFakeOrca(listResponse: unknown): {
  command: string;
  calls: () => string[][];
  dir: string;
  repoPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "harness-worktree-selection-"));
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
  const command = join(dir, "orca.cjs");
  const callsPath = join(dir, "calls.jsonl");
  const listPath = join(dir, "worktree-list.json");
  writeFileSync(listPath, JSON.stringify(listResponse));
  writeFileSync(
    command,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
const key = args.slice(0, 2).join(" ");
const ok = (result) => console.log(JSON.stringify({ ok: true, result }));
if (args[0] === "status") {
  ok({ app: { running: true }, runtime: { state: "ready", reachable: true } });
} else if (key === "repo list") {
  ok({ repos: [{
    id: "repo-1",
    path: ${JSON.stringify(repoPath)},
    worktreeBaseRef: "origin/main",
    gitRemoteIdentity: { canonicalKey: "owner/repo" }
  }] });
} else if (key === "repo show") {
  ok({ repo: {
    id: "repo-1",
    path: ${JSON.stringify(repoPath)},
    worktreeBaseRef: "origin/main",
    gitRemoteIdentity: { canonicalKey: "owner/repo" }
  } });
} else if (key === "worktree list") {
  const response = JSON.parse(readFileSync(${JSON.stringify(listPath)}, "utf8"));
  console.log(JSON.stringify(response));
  if (response.ok === false) process.exitCode = 1;
} else if (key === "worktree create") {
  ok({ worktree: {
    id: "repo-1::/tmp/issue-1",
    path: "/tmp/issue-1",
    branch: "refs/heads/issue-1"
  } });
} else if (key === "terminal list" && args.some((arg) => arg.startsWith("path:"))) {
  ok({ terminals: [{
    handle: "controller-1",
    title: "harness-controller",
    connected: true
  }] });
} else if (key === "terminal list") {
  ok({ terminals: [{
    handle: "terminal-1",
    title: "issue-1-pi",
    connected: true
  }] });
} else if (key === "terminal create") {
  ok({ handle: "terminal-1" });
} else {
  console.log(JSON.stringify({ ok: false, error: { message: "unexpected command: " + key } }));
  process.exitCode = 1;
}
`,
  );
  chmodSync(command, 0o755);
  return {
    command,
    dir,
    repoPath,
    calls: () => {
      try {
        return readFileSync(callsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    },
  };
}
