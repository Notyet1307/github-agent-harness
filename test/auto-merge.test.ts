import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { Ledger } from "../src/ledger.js";
import { waitMerge } from "../src/merge-monitor.js";

type Fixture = {
  dir: string;
  configPath: string;
  ledgerPath: string;
  lockPath: string;
  mergeCallsPath: string;
};

function createFixture(
  t: test.TestContext,
  options: {
    prHead: string;
    baseRefName?: string;
    mergeExitCode?: number;
    mergeStateStatus?: string;
    requiredChecks?: string[];
    autoMergeRequested?: boolean;
    reviewDecision?: string | null;
    statusCheckRollup?: Array<Record<string, string>>;
  },
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "harness-auto-merge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  const configPath = join(dir, "harness.yaml");
  const ledgerPath = join(dir, "harness.sqlite");
  const lockPath = join(dir, "harness.lock");
  const mergeCallsPath = join(dir, "merge-calls.jsonl");
  const expectedHead = "b".repeat(40);
  mkdirSync(binDir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/owner/repo.git"],
    { cwd: dir },
  );

  const fakeGh = join(binDir, "gh");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 1,
    url: "https://example.test/pull/1",
    title: "Test PR",
    state: "OPEN",
    mergedAt: null,
    mergeStateStatus: ${JSON.stringify(options.mergeStateStatus ?? "CLEAN")},
    reviewDecision: ${JSON.stringify(options.reviewDecision ?? "APPROVED")},
    statusCheckRollup: ${JSON.stringify(options.statusCheckRollup ?? [])},
    headRefName: "agent/issue-1",
    headRefOid: ${JSON.stringify(options.prHead)},
    baseRefName: ${JSON.stringify(options.baseRefName ?? "main")},
    autoMergeRequest: ${options.autoMergeRequested ? '{ enabledAt: "2026-07-28T00:00:00Z" }' : "null"}
  }));
} else if (args[0] === "pr" && args[1] === "merge") {
  fs.appendFileSync(${JSON.stringify(mergeCallsPath)}, JSON.stringify(args) + "\\n");
  if (${options.mergeExitCode ?? 0} !== 0) {
    console.error("auto-merge unavailable");
    process.exitCode = ${options.mergeExitCode ?? 0};
  }
} else if (args[0] === "api" && args[1] === "repos/owner/repo/rules/branches/main") {
  const checks = ${JSON.stringify(options.requiredChecks ?? ["test"])};
  console.log(JSON.stringify(checks.length === 0 ? [] : [{
    type: "required_status_checks",
    parameters: { required_status_checks: checks.map((context) => ({ context })) }
  }]));
} else {
  console.error("unexpected gh command: " + args.join(" "));
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
  }}));
} else if (key === "repo list") {
  console.log(JSON.stringify({ ok: true, result: { repos: [{
    id: "repo-1",
    path: ${JSON.stringify(dir)},
    worktreeBaseRef: "origin/main",
    gitRemoteIdentity: { canonicalKey: "owner/repo" }
  }] } }));
} else if (key === "repo show") {
  console.log(JSON.stringify({ ok: true, result: { repo: {
    id: "repo-1",
    path: ${JSON.stringify(dir)},
    worktreeBaseRef: "origin/main",
    gitRemoteIdentity: { canonicalKey: "owner/repo" }
  } } }));
} else {
  console.log(JSON.stringify({ ok: true, result: {} }));
}
`,
  );
  chmodSync(fakeOrca, 0o755);

  writeFileSync(
    configPath,
    `version: 1
issueLabel: ready-for-agent
mergePolicy:
  mode: auto
  autoMerge: true
orca:
  cliPath: ${JSON.stringify(fakeOrca)}
  cliPathFallback: ${JSON.stringify(fakeOrca)}
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
    localPath: ${JSON.stringify(dir)}
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
      localPath: dir,
      orcaRepoId: "repo-1",
      baseRef: "origin/main",
      defaultBranch: "main",
    },
    issue: {
      number: 1,
      title: "Auto merge",
      url: "https://example.test/issues/1",
      updatedAt: "2026-07-28T00:00:00Z",
      blockedBy: [],
      labels: ["ready-for-agent"],
    },
    baseSha: "a".repeat(40),
    implementerProfileId: "codex-default",
  });
  assert.equal(claimed.ok, true);
  ledger.updateJob("job-1", {
    state: "awaiting_merge",
    pr_number: 1,
    pr_url: "https://example.test/pull/1",
    head_sha: expectedHead,
  });
  ledger.close();

  return { dir, configPath, ledgerPath, lockPath, mergeCallsPath };
}

test("auto mode requests GitHub auto-merge for the audited PR head", (t) => {
  const fixture = createFixture(t, { prHead: "b".repeat(40) });
  const originalPath = process.env.PATH;
  process.env.PATH = `${join(fixture.dir, "bin")}:${originalPath ?? ""}`;
  try {
    const result = waitMerge({
      configPath: fixture.configPath,
      ledgerPath: fixture.ledgerPath,
      lockPath: fixture.lockPath,
      timeoutMinutes: 0,
    });

    assert.equal(result.ok, true);
    assert.match(result.message, /still awaiting_merge/);
    assert.deepEqual(
      readFileSync(fixture.mergeCallsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
      [
        [
          "pr",
          "merge",
          "1",
          "--repo",
          "owner/repo",
          "--auto",
          "--match-head-commit",
          "b".repeat(40),
          "--merge",
        ],
      ],
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("auto mode waits for GitHub to report a clean merge state", (t) => {
  const fixture = createFixture(t, {
    prHead: "b".repeat(40),
    mergeStateStatus: "PENDING",
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${join(fixture.dir, "bin")}:${originalPath ?? ""}`;
  try {
    const result = waitMerge({
      configPath: fixture.configPath,
      ledgerPath: fixture.ledgerPath,
      lockPath: fixture.lockPath,
      timeoutMinutes: 0,
    });

    assert.equal(result.ok, true);
    assert.match(result.message, /still awaiting_merge/);
    assert.equal(existsSync(fixture.mergeCallsPath), false);
    const ledger = new Ledger(fixture.ledgerPath);
    assert.equal(ledger.getJob("job-1")?.state, "awaiting_merge");
    ledger.close();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("auto mode blocks a PR that targets a different base branch", (t) => {
  const fixture = createFixture(t, {
    prHead: "b".repeat(40),
    baseRefName: "release",
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${join(fixture.dir, "bin")}:${originalPath ?? ""}`;
  try {
    const result = waitMerge({
      configPath: fixture.configPath,
      ledgerPath: fixture.ledgerPath,
      lockPath: fixture.lockPath,
      timeoutMinutes: 0,
    });

    assert.equal(result.ok, false);
    assert.match(
      result.message,
      /PR base release differs from configured default branch main/,
    );
    assert.equal(existsSync(fixture.mergeCallsPath), false);
    const ledger = new Ledger(fixture.ledgerPath);
    assert.equal(ledger.getJob("job-1")?.state, "blocked");
    ledger.close();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("auto mode blocks when the PR head differs from the audited head", (t) => {
  const fixture = createFixture(t, { prHead: "c".repeat(40) });
  const originalPath = process.env.PATH;
  process.env.PATH = `${join(fixture.dir, "bin")}:${originalPath ?? ""}`;
  try {
    const result = waitMerge({
      configPath: fixture.configPath,
      ledgerPath: fixture.ledgerPath,
      lockPath: fixture.lockPath,
      timeoutMinutes: 0,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /PR head .* differs from audited head/);
    assert.equal(existsSync(fixture.mergeCallsPath), false);
    const ledger = new Ledger(fixture.ledgerPath);
    assert.equal(ledger.getJob("job-1")?.state, "blocked");
    ledger.close();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("auto mode disables an already requested PR when its head changes", (t) => {
  const fixture = createFixture(t, {
    prHead: "c".repeat(40),
    autoMergeRequested: true,
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${join(fixture.dir, "bin")}:${originalPath ?? ""}`;
  try {
    const result = waitMerge({
      configPath: fixture.configPath,
      ledgerPath: fixture.ledgerPath,
      lockPath: fixture.lockPath,
      timeoutMinutes: 0,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /PR head .* differs from audited head/);
    assert.deepEqual(
      readFileSync(fixture.mergeCallsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
      [["pr", "merge", "1", "--repo", "owner/repo", "--disable-auto"]],
    );
    const ledger = new Ledger(fixture.ledgerPath);
    assert.equal(ledger.getJob("job-1")?.state, "blocked");
    ledger.close();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("auto mode disables an already requested PR after changes are requested", (t) => {
  const fixture = createFixture(t, {
    prHead: "b".repeat(40),
    autoMergeRequested: true,
    reviewDecision: "CHANGES_REQUESTED",
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${join(fixture.dir, "bin")}:${originalPath ?? ""}`;
  try {
    const result = waitMerge({
      configPath: fixture.configPath,
      ledgerPath: fixture.ledgerPath,
      lockPath: fixture.lockPath,
      timeoutMinutes: 0,
    });

    assert.equal(result.ok, true);
    assert.match(result.message, /still awaiting_merge/);
    assert.deepEqual(
      readFileSync(fixture.mergeCallsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
      [["pr", "merge", "1", "--repo", "owner/repo", "--disable-auto"]],
    );
    const ledger = new Ledger(fixture.ledgerPath);
    assert.equal(ledger.getJob("job-1")?.state, "awaiting_merge");
    assert.equal(
      ledger.getJob("job-1")?.last_error,
      "reviewDecision=CHANGES_REQUESTED",
    );
    ledger.close();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("auto mode disables an already requested PR when its changed head has failed CI", (t) => {
  const fixture = createFixture(t, {
    prHead: "c".repeat(40),
    autoMergeRequested: true,
    mergeStateStatus: "UNSTABLE",
    statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }],
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${join(fixture.dir, "bin")}:${originalPath ?? ""}`;
  try {
    const result = waitMerge({
      configPath: fixture.configPath,
      ledgerPath: fixture.ledgerPath,
      lockPath: fixture.lockPath,
      timeoutMinutes: 0,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /PR head .* differs from audited head/);
    assert.deepEqual(
      readFileSync(fixture.mergeCallsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
      [["pr", "merge", "1", "--repo", "owner/repo", "--disable-auto"]],
    );
    const ledger = new Ledger(fixture.ledgerPath);
    assert.equal(ledger.getJob("job-1")?.state, "blocked");
    assert.match(
      ledger.getJob("job-1")?.last_error ?? "",
      /PR head .* differs from audited head/,
    );
    ledger.close();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("auto mode blocks without branch-required CI checks", (t) => {
  const fixture = createFixture(t, {
    prHead: "b".repeat(40),
    requiredChecks: [],
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${join(fixture.dir, "bin")}:${originalPath ?? ""}`;
  try {
    const result = waitMerge({
      configPath: fixture.configPath,
      ledgerPath: fixture.ledgerPath,
      lockPath: fixture.lockPath,
      timeoutMinutes: 0,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /required status checks/);
    assert.equal(existsSync(fixture.mergeCallsPath), false);
    const ledger = new Ledger(fixture.ledgerPath);
    assert.equal(ledger.getJob("job-1")?.state, "blocked");
    ledger.close();
  } finally {
    process.env.PATH = originalPath;
  }
});

test("invalid merge policy combinations fail closed while loading config", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-merge-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "harness.yaml");
  writeFileSync(
    configPath,
    `version: 1
issueLabel: ready-for-agent
mergePolicy:
  mode: auto
  autoMerge: false
repositories: []
`,
  );

  assert.throws(() => loadConfig(configPath), /mergePolicy/);
});
