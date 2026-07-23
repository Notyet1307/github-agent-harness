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
import { auditOnce } from "../src/audit-once.js";
import { Ledger } from "../src/ledger.js";
import type { AuditResult } from "../src/types.js";

type AuditFixture = {
  dir: string;
  worktree: string;
  baseSha: string;
  headSha: string;
  configPath: string;
  ledgerPath: string;
  callsPath: string;
};

type AuditResultFactory = (
  baseSha: string,
  headSha: string,
) => AuditResult | string | null;

test("a fresh audit round blocks and keeps an incomplete dispatch tuple", (t) => {
  const fixture = createAuditFixture((baseSha, headSha) =>
    auditResult("pass", baseSha, headSha),
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-audit", {
    state: "awaiting_audit",
    base_sha: fixture.baseSha,
    worktree_id: "worktree-1",
    worktree_path: fixture.worktree,
    head_sha: fixture.headSha,
  });
  ledger.close();

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: false,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /missing dispatchId/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.equal(
    verified.getJob("job-audit")?.auditor_task_id,
    "task-audit-new",
  );
  assert.equal(verified.getJob("job-audit")?.auditor_dispatch_id, null);
  assert.equal(verified.getJob("job-audit")?.dispatch_attempt, 1);
  verified.close();
});

const evidenceFailureCases: Array<{
  name: string;
  result: AuditResultFactory;
  message: RegExp;
}> = [
  {
    name: "fail without blockers",
    result: (baseSha, headSha) => auditResult("fail", baseSha, headSha),
    message: /without actionable evidence/,
  },
  {
    name: "explicit uncertain",
    result: (baseSha, headSha) => auditResult("uncertain", baseSha, headSha),
    message: /auditor reported uncertain/,
  },
  {
    name: "missing result",
    result: () => null,
    message: /audit result file missing/,
  },
  {
    name: "invalid JSON",
    result: () => "{not-json",
    message: /invalid audit JSON/,
  },
  {
    name: "SHA mismatch",
    result: (baseSha) => auditResult("pass", baseSha, "c".repeat(40)),
    message: /different base\/head SHAs/,
  },
];

for (const scenario of evidenceFailureCases) {
  test(`non-actionable audit evidence blocks without rework: ${scenario.name}`, (t) => {
    const fixture = createAuditFixture(scenario.result);
    t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
    markCompletedAudit(fixture);

    const result = auditOnce({
      configPath: fixture.configPath,
      ledgerPath: fixture.ledgerPath,
      lockPath: join(fixture.dir, "harness.lock"),
      withRework: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, scenario.message);
    const verified = new Ledger(fixture.ledgerPath);
    assert.equal(verified.getJob("job-audit")?.state, "blocked");
    assert.equal(verified.getJob("job-audit")?.implementer_task_id, null);
    verified.close();
    assert.equal(
      readCalls(fixture.callsPath).some(isReworkCreation),
      false,
    );
  });
}

test("an actionable audit failure still enters rework dispatch", (t) => {
  const fixture = createAuditFixture((baseSha, headSha) => {
    const result = auditResult("fail", baseSha, headSha);
    result.spec.incorrect_implementation = [{ summary: "wrong behavior" }];
    return result;
  });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markCompletedAudit(fixture);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /missing dispatchId/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(
    verified.getJob("job-audit")?.implementer_task_id,
    "task-audit-new",
  );
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ),
    true,
  );
});

function createAuditFixture(resultFactory: AuditResultFactory): AuditFixture {
  const dir = mkdtempSync(join(tmpdir(), "audit-provenance-"));
  const worktree = join(dir, "worktree");
  mkdirSync(worktree);
  git(worktree, "init", "-b", "main");
  git(worktree, "config", "user.name", "Harness Test");
  git(worktree, "config", "user.email", "harness@example.test");
  writeFileSync(join(worktree, "value.txt"), "base\n");
  git(worktree, "add", "value.txt");
  git(worktree, "commit", "-m", "base");
  const baseSha = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "value.txt"), "head\n");
  git(worktree, "add", "value.txt");
  git(worktree, "commit", "-m", "head");
  const headSha = git(worktree, "rev-parse", "HEAD");

  mkdirSync(join(worktree, ".harness"));
  const result = resultFactory(baseSha, headSha);
  if (result !== null) {
    writeFileSync(
      join(worktree, ".harness", "audit-result.json"),
      typeof result === "string" ? result : JSON.stringify(result),
    );
  }

  const callsPath = join(dir, "calls.jsonl");
  writeFileSync(callsPath, "");
  const fakeOrca = join(dir, "orca.cjs");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
appendFileSync(join(dirname(process.argv[1]), "calls.jsonl"), JSON.stringify(args) + "\\n");
const key = args.slice(0, 2).join(" ");
if (args[0] === "status") {
  console.log(JSON.stringify({ ok: true, result: {
    app: { running: true },
    runtime: { state: "ready", reachable: true }
  } }));
} else if (key === "terminal list") {
  console.log(JSON.stringify({ ok: true, result: {
    terminals: [{ handle: "controller-1", title: "test-controller", connected: true }]
  } }));
} else if (key === "terminal create") {
  console.log(JSON.stringify({ ok: true, result: { handle: "pi-new" } }));
} else if (key === "terminal wait") {
  console.log(JSON.stringify({ ok: true, result: {
    wait: { satisfied: true, status: "idle", blockedReason: null }
  } }));
} else if (key === "terminal read") {
  console.log(JSON.stringify({ ok: true, result: { terminal: {
    tail: [],
    nextCursor: "1",
    latestCursor: "1"
  } } }));
} else if (key === "orchestration task-list") {
  console.log(JSON.stringify({ ok: true, result: {
    tasks: [{ id: "task-audit", status: "completed" }]
  } }));
} else if (key === "orchestration task-create") {
  console.log(JSON.stringify({ ok: true, result: {
    taskId: "task-audit-new"
  } }));
} else if (key === "orchestration dispatch") {
  console.log(JSON.stringify({ ok: true, result: {} }));
} else if (key === "orchestration task-update") {
  console.log(JSON.stringify({ ok: false, error: {
    message: "task update unavailable"
  } }));
  process.exitCode = 1;
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
maxAuditRounds: 3
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
    localPath: ${JSON.stringify(worktree)}
    orcaRepoId: repo-1
    baseRef: origin/main
    defaultBranch: main
`,
  );

  const ledgerPath = join(dir, "harness.sqlite");
  const ledger = new Ledger(ledgerPath);
  assert.equal(
    ledger.tryClaim({
      id: "job-audit",
      repo: "owner/repo",
      issue: {
        number: 9,
        title: "Audit provenance",
        url: "https://example.test/issues/9",
        updatedAt: "2026-07-23T00:00:00Z",
        blockedBy: [],
        labels: ["ready-for-agent"],
      },
      baseRef: "origin/main",
      implementerProfileId: "codex-default",
    }).ok,
    true,
  );
  ledger.close();

  return {
    dir,
    worktree,
    baseSha,
    headSha,
    configPath,
    ledgerPath,
    callsPath,
  };
}

function markCompletedAudit(fixture: AuditFixture): void {
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-audit", {
    state: "auditing",
    base_sha: fixture.baseSha,
    worktree_id: "worktree-1",
    worktree_path: fixture.worktree,
    head_sha: fixture.headSha,
    audit_round: 1,
    audit_head_sha: fixture.headSha,
    auditor_profile_id: "pi-reviewer",
    auditor_terminal_handle: "pi-audit",
    auditor_task_id: "task-audit",
    auditor_dispatch_id: "dispatch-audit",
  });
  ledger.close();
}

function auditResult(
  status: AuditResult["status"],
  baseSha: string,
  headSha: string,
): AuditResult {
  return {
    status,
    base_sha: baseSha,
    head_sha: headSha,
    standards: {
      documented_standard_violations: [],
      smell_judgement_calls: [],
    },
    spec: {
      missing_or_partial: [],
      incorrect_implementation: [],
      scope_creep: [],
    },
    validation: {
      commands: [{ command: "npm test", exit_code: 0, ok: true }],
    },
  };
}

function readCalls(path: string): string[][] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function isReworkCreation(args: string[]): boolean {
  return (
    (args[0] === "terminal" && args[1] === "create") ||
    (args[0] === "orchestration" && args[1] === "task-create")
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}
