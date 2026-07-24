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

type AuditFixtureMode =
  | "missing-dispatch"
  | "rework-noop"
  | "rework-diverge"
  | "rework-dirty"
  | "rework-commit"
  | "rework-escalated-commit"
  | "rework-late-commit"
  | "rework-resume-commit"
  | "rework-working-commit"
  | "rework-failed-commit"
  | "rework-late-failed"
  | "rework-pending-failed"
  | "rework-retry-drift"
  | "rework-stale-terminal";

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
  const fixture = createAuditFixture(actionableAuditFailure);
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

test("rework must add a commit after the audited HEAD", (t) => {
  const fixture = createAuditFixture(actionableAuditFailure, "rework-noop");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /no commits after audited HEAD/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.equal(verified.getJob("job-audit")?.head_sha, fixture.headSha);
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ),
    false,
  );
});

test("rework HEAD must descend from the audited HEAD", (t) => {
  const fixture = createAuditFixture(
    actionableAuditFailure,
    "rework-diverge",
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /not a descendant of audited HEAD/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ),
    false,
  );
});

test("new rework dispatch requires the exact audited HEAD", (t) => {
  const fixture = createAuditFixture(actionableAuditFailure);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  writeFileSync(join(fixture.worktree, "value.txt"), "external change\n");
  git(fixture.worktree, "add", "value.txt");
  git(fixture.worktree, "commit", "-m", "external change");
  markReworking(fixture, false);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /HEAD changed before rework dispatch/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.equal(verified.getJob("job-audit")?.implementer_task_id, null);
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ),
    false,
  );
});

test("new rework dispatch requires a clean tracked worktree", (t) => {
  const fixture = createAuditFixture(actionableAuditFailure);
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  writeFileSync(join(fixture.worktree, "value.txt"), "uncommitted change\n");
  markReworking(fixture, false);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /tracked files dirty before rework dispatch/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.equal(verified.getJob("job-audit")?.implementer_task_id, null);
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ),
    false,
  );
});

test("resumes a pending rework dispatch after its worker committed", (t) => {
  const fixture = createAuditFixture(actionableAuditFailure, "rework-noop");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);
  writeFileSync(join(fixture.worktree, "value.txt"), "worker fix\n");
  git(fixture.worktree, "add", "value.txt");
  git(fixture.worktree, "commit", "-m", "worker fix");
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-audit", { dispatch_probe_pending: 1 });
  ledger.close();

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, true, result.message);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "audit_passed");
  assert.equal(verified.getJob("job-audit")?.implementer_task_id, "task-rework");
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).filter(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ).length,
    1,
  );
});

test("resumes a pending failed acceptance before applying the failed-task guard", (t) => {
  const fixture = createAuditFixture(
    actionableAuditFailure,
    "rework-pending-failed",
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-audit", { dispatch_probe_pending: 1 });
  ledger.close();

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /task task-rework is not completed.*failed/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.equal(verified.getJob("job-audit")?.dispatch_probe_pending, 0);
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).filter(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ).length,
    0,
  );
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) => args[0] === "orchestration" && args[1] === "check",
    ),
    false,
  );
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) => args[0] === "terminal" && args[1] === "read",
    ),
    true,
  );
});

test("resumes a committed rework when worker_done was lost", (t) => {
  const fixture = createAuditFixture(
    actionableAuditFailure,
    "rework-resume-commit",
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);
  writeFileSync(join(fixture.worktree, "value.txt"), "recovered fix\n");
  git(fixture.worktree, "add", "value.txt");
  git(fixture.worktree, "commit", "-m", "recovered fix");

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, true, result.message);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "audit_passed");
  assert.equal(verified.getJob("job-audit")?.audit_round, 2);
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).filter(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ).length,
    1,
  );
});

test("does not re-audit committed rework while its task is still working", (t) => {
  const fixture = createAuditFixture(
    actionableAuditFailure,
    "rework-working-commit",
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);
  writeFileSync(join(fixture.worktree, "value.txt"), "unfinished fix\n");
  git(fixture.worktree, "add", "value.txt");
  git(fixture.worktree, "commit", "-m", "unfinished fix");

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /task task-rework is not completed.*working/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.equal(verified.getJob("job-audit")?.audit_round, 1);
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) => args[0] === "orchestration" && args[1] === "check",
    ),
    true,
  );
});

test("blocks committed rework immediately when its task failed", (t) => {
  const fixture = createAuditFixture(
    actionableAuditFailure,
    "rework-failed-commit",
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);
  writeFileSync(join(fixture.worktree, "value.txt"), "failed fix\n");
  git(fixture.worktree, "add", "value.txt");
  git(fixture.worktree, "commit", "-m", "failed fix");
  writeFileSync(join(fixture.worktree, "value.txt"), "dirty failed fix\n");
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-audit", { dispatch_probe_pending: 1 });
  ledger.close();

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /task task-rework is not completed.*failed/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.equal(verified.getJob("job-audit")?.audit_round, 1);
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) => args[0] === "orchestration" && args[1] === "check",
    ),
    false,
  );
});

test("does not accept rework worker_done after the task becomes failed", (t) => {
  const fixture = createAuditFixture(
    actionableAuditFailure,
    "rework-late-failed",
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /task task-rework is not completed.*failed/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.equal(verified.getJob("job-audit")?.audit_round, 1);
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) => args[0] === "orchestration" && args[1] === "check",
    ),
    true,
  );
});

test("reports invalid rework evidence when worker_done is also lost", (t) => {
  const fixture = createAuditFixture(
    actionableAuditFailure,
    "rework-resume-commit",
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /no commits after audited HEAD/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.match(
    verified.getJob("job-audit")?.last_error ?? "",
    /no commits after audited HEAD/,
  );
  verified.close();
});

test("recovers a rework commit that lands while worker_done times out", (t) => {
  const fixture = createAuditFixture(
    actionableAuditFailure,
    "rework-late-commit",
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, true, result.message);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "audit_passed");
  assert.equal(verified.getJob("job-audit")?.audit_round, 2);
  verified.close();
});

test("does not recover a committed rework after worker escalation", (t) => {
  const fixture = createAuditFixture(
    actionableAuditFailure,
    "rework-escalated-commit",
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /worker sent escalation/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  verified.close();
});

test("rebinds a stale implementer terminal before rework dispatch", (t) => {
  const fixture = createAuditFixture(
    actionableAuditFailure,
    "rework-stale-terminal",
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture, false);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, true, result.message);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "audit_passed");
  assert.equal(
    verified.getJob("job-audit")?.implementer_terminal_handle,
    "implementer-new",
  );
  verified.close();
  const dispatches = readCalls(fixture.callsPath).filter(
    (args) => args[0] === "orchestration" && args[1] === "dispatch",
  );
  assert.equal(
    dispatches.some((args) => args.includes("implementer-1")),
    false,
  );
  assert.equal(
    dispatches.some((args) => args.includes("implementer-new")),
    true,
  );
});

test("rework retry rechecks the audited HEAD before creating another task", (t) => {
  const fixture = createAuditFixture(
    actionableAuditFailure,
    "rework-retry-drift",
  );
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture, false);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /HEAD changed before rework dispatch/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.equal(
    verified.getJob("job-audit")?.implementer_task_id,
    "task-rework-1",
  );
  assert.equal(
    verified.getJob("job-audit")?.implementer_dispatch_id,
    "dispatch-rework-1",
  );
  assert.equal(
    verified.getJob("job-audit")?.implementer_terminal_handle,
    "pi-new",
  );
  assert.equal(verified.getJob("job-audit")?.dispatch_probe_pending, 0);
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).filter(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ).length,
    1,
  );
});

test("rework must leave tracked files clean", (t) => {
  const fixture = createAuditFixture(actionableAuditFailure, "rework-dirty");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /tracked files dirty after rework/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.match(
    verified.getJob("job-audit")?.last_error ?? "",
    /value\.txt/,
  );
  verified.close();
});

test("rework reports Git ancestry errors separately from divergence", (t) => {
  const fixture = createAuditFixture(actionableAuditFailure, "rework-noop");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-audit", { audit_head_sha: "d".repeat(40) });
  ledger.close();

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /cannot verify rework ancestry/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  verified.close();
});

test("a clean descendant rework resumes into a passing audit", (t) => {
  const fixture = createAuditFixture(actionableAuditFailure, "rework-commit");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, true, result.message);
  const reworkedHead = git(fixture.worktree, "rev-parse", "HEAD");
  assert.notEqual(reworkedHead, fixture.headSha);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "audit_passed");
  assert.equal(verified.getJob("job-audit")?.audit_round, 2);
  assert.equal(verified.getJob("job-audit")?.audit_head_sha, reworkedHead);
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).filter(
      (args) =>
        args[0] === "orchestration" && args[1] === "task-create",
    ).length,
    1,
  );
});

test("rework blocks when the audited HEAD provenance is missing", (t) => {
  const fixture = createAuditFixture(actionableAuditFailure, "rework-noop");
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  markReworking(fixture);
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-audit", { audit_head_sha: null });
  ledger.close();

  const result = auditOnce({
    configPath: fixture.configPath,
    ledgerPath: fixture.ledgerPath,
    lockPath: join(fixture.dir, "harness.lock"),
    withRework: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /missing audited HEAD/);
  const verified = new Ledger(fixture.ledgerPath);
  assert.equal(verified.getJob("job-audit")?.state, "blocked");
  assert.equal(verified.getJob("job-audit")?.implementer_task_id, "task-rework");
  verified.close();
  assert.equal(
    readCalls(fixture.callsPath).some(
      (args) => args[0] === "orchestration" && args[1] === "check",
    ),
    false,
  );
});

function createAuditFixture(
  resultFactory: AuditResultFactory,
  mode: AuditFixtureMode = "missing-dispatch",
): AuditFixture {
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
  writeFileSync(join(dir, "mode"), mode);
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ checks: 0, tasks: 0, mutationApplied: false }),
  );
  const fakeOrca = join(dir, "orca.cjs");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { dirname, join } = require("node:path");
const dir = dirname(process.argv[1]);
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify(args) + "\\n");
const mode = readFileSync(join(dir, "mode"), "utf8");
const reworkMode = mode.startsWith("rework-");
const statePath = join(dir, "state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const key = args.slice(0, 2).join(" ");
if (args[0] === "status") {
  console.log(JSON.stringify({ ok: true, result: {
    app: { running: true },
    runtime: { state: "ready", reachable: true }
  } }));
} else if (key === "terminal list") {
  console.log(JSON.stringify({ ok: true, result: {
    terminals:
      mode === "rework-stale-terminal" && args.includes("id:worktree-1")
        ? []
        : [{ handle: "controller-1", title: "test-controller", connected: true }]
  } }));
} else if (key === "terminal create") {
  const title = args[args.indexOf("--title") + 1] || "";
  console.log(JSON.stringify({ ok: true, result: { handle:
    mode === "rework-stale-terminal"
      ? title.includes("audit") ? "auditor-new" : "implementer-new"
      : "pi-new"
  } }));
} else if (key === "terminal wait") {
  if (mode === "rework-stale-terminal" && args.includes("implementer-1")) {
    console.log(JSON.stringify({ ok: false, error: {
      message: "terminal implementer-1 not found"
    } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, result: {
      wait: { satisfied: true, status: "idle", blockedReason: null }
    } }));
  }
} else if (key === "terminal read") {
  const fresh = args.includes("--cursor");
  if (mode === "rework-retry-drift" && fresh && !state.mutationApplied) {
    writeFileSync(${JSON.stringify(join(worktree, "value.txt"))}, "retry drift\\n");
    execFileSync(
      "git",
      ["-C", ${JSON.stringify(worktree)}, "add", "value.txt"]
    );
    execFileSync(
      "git",
      ["-C", ${JSON.stringify(worktree)}, "commit", "-m", "retry drift"]
    );
    state.mutationApplied = true;
    writeFileSync(statePath, JSON.stringify(state));
  }
  console.log(JSON.stringify({ ok: true, result: { terminal: {
    tail:
      mode === "rework-stale-terminal"
        ? state.tasks === 0
          ? []
          : [state.tasks === 1
            ? "Working on task-rework-new"
            : "Working on task-audit-new"]
        : mode === "rework-retry-drift" && fresh
        ? ["Provider unavailable: model error"]
        : reworkMode
          ? ["Working on task-rework"]
          : [],
    nextCursor: "1",
    latestCursor: "1"
  } } }));
} else if (key === "terminal show") {
  console.log(JSON.stringify({ ok: true, result: {
    terminal: { title: "agent", preview: "" }
  } }));
} else if (key === "orchestration task-list") {
  console.log(JSON.stringify({ ok: true, result: {
    tasks: [
      { id: "task-audit", status: "completed" },
      {
        id: "task-rework",
        status:
          mode === "rework-late-failed"
            ? state.checks === 0 ? "working" : "failed"
            : mode === "rework-failed-commit" ||
          mode === "rework-pending-failed"
            ? "failed"
            : mode === "rework-working-commit"
              ? "working"
              : "completed"
      }
    ]
  } }));
} else if (key === "orchestration task-create") {
  state.tasks += 1;
  writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify({ ok: true, result: {
    taskId:
      mode === "rework-stale-terminal"
        ? state.tasks === 1 ? "task-rework-new" : "task-audit-new"
        : mode === "rework-retry-drift"
          ? "task-rework-" + state.tasks
          : "task-audit-new"
  } }));
} else if (key === "orchestration dispatch") {
  if (mode === "rework-stale-terminal" && state.tasks === 1) {
    console.log(JSON.stringify({ ok: true, result: {
      dispatchId: "dispatch-rework-new"
    } }));
  } else if (mode === "rework-retry-drift") {
    console.log(JSON.stringify({ ok: true, result:
      state.tasks === 1 ? { dispatchId: "dispatch-rework-1" } : {}
    }));
  } else if (reworkMode) {
    const headSha = execFileSync(
      "git",
      ["-C", ${JSON.stringify(worktree)}, "rev-parse", "HEAD"],
      { encoding: "utf8" }
    ).trim();
    writeFileSync(
      ${JSON.stringify(join(worktree, ".harness", "audit-result.json"))},
      JSON.stringify({
        status: "pass",
        base_sha: ${JSON.stringify(baseSha)},
        head_sha: headSha,
        standards: {
          documented_standard_violations: [],
          smell_judgement_calls: []
        },
        spec: {
          missing_or_partial: [],
          incorrect_implementation: [],
          scope_creep: []
        },
        validation: {
          commands: [{ command: "npm test", exit_code: 0, ok: true }]
        }
      })
    );
    console.log(JSON.stringify({ ok: true, result: {
      dispatchId: "dispatch-audit-new"
    } }));
  } else {
    console.log(JSON.stringify({ ok: true, result: {} }));
  }
} else if (key === "orchestration task-update") {
  if (reworkMode) {
    console.log(JSON.stringify({ ok: true, result: {} }));
  } else {
    console.log(JSON.stringify({ ok: false, error: {
      message: "task update unavailable"
    } }));
    process.exitCode = 1;
  }
} else if (key === "orchestration check" && reworkMode) {
  state.checks += 1;
  writeFileSync(statePath, JSON.stringify(state));
  if (mode === "rework-escalated-commit") {
    if (state.tasks > 0) {
      console.log(JSON.stringify({ ok: true, result: { messages: [{
        type: "worker_done",
        taskId: "task-audit-new",
        dispatchId: "dispatch-audit-new"
      }] } }));
      process.exit(0);
    }
    if (!state.mutationApplied) {
      writeFileSync(${JSON.stringify(join(worktree, "value.txt"))}, "escalated fix\\n");
      execFileSync(
        "git",
        ["-C", ${JSON.stringify(worktree)}, "add", "value.txt"]
      );
      execFileSync(
        "git",
        ["-C", ${JSON.stringify(worktree)}, "commit", "-m", "escalated fix"]
      );
      state.mutationApplied = true;
      writeFileSync(statePath, JSON.stringify(state));
    }
    console.log(JSON.stringify({ ok: true, result: { messages: [{
      type: "escalation",
      taskId: "task-rework",
      dispatchId: "dispatch-rework"
    }] } }));
    process.exit(0);
  }
  if (mode === "rework-stale-terminal") {
    if (state.tasks === 1 && !state.mutationApplied) {
      writeFileSync(${JSON.stringify(join(worktree, "value.txt"))}, "rebound fix\\n");
      execFileSync(
        "git",
        ["-C", ${JSON.stringify(worktree)}, "add", "value.txt"]
      );
      execFileSync(
        "git",
        ["-C", ${JSON.stringify(worktree)}, "commit", "-m", "rebound fix"]
      );
      state.mutationApplied = true;
      writeFileSync(statePath, JSON.stringify(state));
    }
    console.log(JSON.stringify({ ok: true, result: { messages: [{
      type: "worker_done",
      taskId: state.tasks === 1 ? "task-rework-new" : "task-audit-new",
      dispatchId:
        state.tasks === 1 ? "dispatch-rework-new" : "dispatch-audit-new"
    }] } }));
    process.exit(0);
  }
  if (mode === "rework-late-commit") {
    if (state.tasks === 0 && !state.mutationApplied) {
      writeFileSync(${JSON.stringify(join(worktree, "value.txt"))}, "late fix\\n");
      execFileSync(
        "git",
        ["-C", ${JSON.stringify(worktree)}, "add", "value.txt"]
      );
      execFileSync(
        "git",
        ["-C", ${JSON.stringify(worktree)}, "commit", "-m", "late fix"]
      );
      state.mutationApplied = true;
      writeFileSync(statePath, JSON.stringify(state));
    }
    console.log(JSON.stringify({ ok: true, result: { messages:
      state.tasks === 0 ? [] : [{
        type: "worker_done",
        taskId: "task-audit-new",
        dispatchId: "dispatch-audit-new"
      }]
    } }));
    process.exit(0);
  }
  if (
    mode === "rework-resume-commit" ||
    mode === "rework-working-commit" ||
    mode === "rework-failed-commit"
  ) {
    console.log(JSON.stringify({ ok: true, result: { messages:
      state.tasks === 0 ? [] : [{
        type: "worker_done",
        taskId: "task-audit-new",
        dispatchId: "dispatch-audit-new"
      }]
    } }));
    process.exit(0);
  }
  const first = state.checks === 1;
  if (first && mode === "rework-diverge") {
    const tree = execFileSync(
      "git",
      ["-C", ${JSON.stringify(worktree)}, "rev-parse", "HEAD^{tree}"],
      { encoding: "utf8" }
    ).trim();
    const divergentHead = execFileSync(
      "git",
      ["-C", ${JSON.stringify(worktree)}, "commit-tree", tree, "-m", "divergent rework"],
      { encoding: "utf8" }
    ).trim();
    execFileSync(
      "git",
      ["-C", ${JSON.stringify(worktree)}, "reset", "--hard", divergentHead]
    );
  }
  if (
    first &&
    (
      mode === "rework-dirty" ||
      mode === "rework-commit" ||
      mode === "rework-late-failed"
    )
  ) {
    writeFileSync(${JSON.stringify(join(worktree, "value.txt"))}, "reworked\\n");
    execFileSync(
      "git",
      ["-C", ${JSON.stringify(worktree)}, "add", "value.txt"]
    );
    execFileSync(
      "git",
      ["-C", ${JSON.stringify(worktree)}, "commit", "-m", "rework"]
    );
  }
  if (first && mode === "rework-dirty") {
    writeFileSync(${JSON.stringify(join(worktree, "value.txt"))}, "dirty\\n");
  }
  console.log(JSON.stringify({ ok: true, result: { messages: [{
    type: "worker_done",
    taskId: first ? "task-rework" : "task-audit-new",
    dispatchId: first ? "dispatch-rework" : "dispatch-audit-new"
  }] } }));
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
implementTimeoutMinutes: ${
      mode === "rework-resume-commit" ||
      mode === "rework-working-commit" ||
      mode === "rework-failed-commit"
        ? 0.001
        : mode === "rework-late-commit"
          ? 0.001
          : 45
    }
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

function markReworking(
  fixture: AuditFixture,
  withTask = true,
): void {
  const result = actionableAuditFailure(fixture.baseSha, fixture.headSha);
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-audit", {
    state: "reworking",
    base_sha: fixture.baseSha,
    worktree_id: "worktree-1",
    worktree_path: fixture.worktree,
    head_sha: fixture.headSha,
    audit_round: 1,
    audit_head_sha: fixture.headSha,
    audit_result_json: JSON.stringify(result),
    implementer_profile_id: "codex-default",
    implementer_terminal_handle: "implementer-1",
    implementer_task_id: withTask ? "task-rework" : null,
    implementer_dispatch_id: withTask ? "dispatch-rework" : null,
    controller_terminal_handle: "controller-1",
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

function actionableAuditFailure(
  baseSha: string,
  headSha: string,
): AuditResult {
  const result = auditResult("fail", baseSha, headSha);
  result.spec.incorrect_implementation = [{ summary: "wrong behavior" }];
  return result;
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
