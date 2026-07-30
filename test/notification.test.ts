import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.js";
import {
  blockedEventKey,
  notifyActiveIntervention,
  notifyStatusEvent,
  renderBlockedNotification,
  renderInterventionNotification,
  renderStatusNotification,
} from "../src/notification.js";
import type { ExecResult } from "../src/exec.js";
import type { Job, WorkerIntervention } from "../src/types.js";
import { testProject } from "./support.js";

const observedAt = "2026-07-29T00:00:00.000Z";

function intervention(): WorkerIntervention {
  return {
    version: 1,
    kind: "decision_gate",
    sourceState: "implementing",
    role: "implementer",
    messageId: "message-1",
    taskId: "task-1",
    dispatchId: "dispatch-1",
    headSha: "abc123",
    body: "Should we expand scope and migrate historical data?",
    payload: {
      question: "Migrate all stored addresses?",
      options: ["account only", "global migration"],
      recommendation: "global migration",
      risks: ["upgrade failure"],
    },
    observedAt,
  };
}

function fakeJob(): Job {
  return {
    id: "job-1",
    repo: "owner/repo",
    issue_number: 20,
    issue_url: "https://example.test/issues/20",
    issue_updated_at: observedAt,
    issue_snapshot_json: JSON.stringify({ title: "Account audit" }),
    project_key: "owner/repo",
    project_revision: "revision",
    project_snapshot_json: "{}",
    state: "blocked",
    base_ref: "origin/main",
    base_sha: "base123",
    branch: "agent/20",
    worktree_id: "worktree-1",
    worktree_path: "/tmp/worktree-1",
    implementer_profile_id: "codex-default",
    implementer_terminal_handle: null,
    implementer_task_id: "task-1",
    implementer_dispatch_id: "dispatch-1",
    auditor_profile_id: null,
    auditor_terminal_handle: null,
    auditor_task_id: null,
    auditor_dispatch_id: null,
    dispatch_attempt: 1,
    dispatch_probe_pending: 0,
    controller_terminal_handle: null,
    audit_round: 0,
    audit_result_json: null,
    audit_head_sha: null,
    pr_number: null,
    pr_url: null,
    merged_at: null,
    last_error: "worker requested a human decision",
    intervention_json: JSON.stringify(intervention()),
    intervention_resolved_at: null,
    head_sha: "abc123",
    revision: 7,
    created_at: observedAt,
    updated_at: observedAt,
  };
}

test("notification includes exact provenance, worker guidance, advice, and reply command", () => {
  const rendered = renderInterventionNotification(fakeJob(), intervention());
  assert.match(rendered, /owner\/repo#20 Account audit/);
  assert.match(rendered, /job-1（通知时 revision 7）/);
  assert.match(rendered, /Task：task-1/);
  assert.match(rendered, /Worker 推荐：global migration/);
  assert.match(rendered, /保持原 Issue 范围/);
  assert.match(rendered, /recover --execute --reply/);
  assert.match(rendered, /Telegram 回复都不会自动解除 blocked/);
});

test("blocked audit failure is rendered and keyed independently of interventions", () => {
  const job = fakeJob();
  job.intervention_json = null;
  job.last_error = "audit failed on final round 3: blocking findings standards=0 spec=1 validation=0";
  const rendered = renderBlockedNotification(job);

  assert.match(rendered, /Harness 任务已阻塞/);
  assert.match(rendered, /audit failed on final round 3/);
  assert.match(rendered, /recover --dry-run/);
  assert.match(blockedEventKey(job), /job-1:blocked:abc123:0:audit failed/);
});

test("blocked jobs notify even without a worker intervention", (t) => {
  const fixture = createFixture(t, 3);
  const ledger = new Ledger(fixture.ledgerPath);
  ledger.updateJob("job-1", {
    intervention_json: null,
    last_error: "audit failed on final round 3: blocking findings standards=0 spec=1 validation=0",
  });
  ledger.close();
  const inputs: string[] = [];

  const result = notifyActiveIntervention({
    ...fixture,
    now: new Date("2026-07-29T00:01:00Z"),
    exec: (_command, _args, options = {}) => {
      inputs.push(options.input ?? "");
      return { ok: true, code: 0, stdout: "{}", stderr: "" };
    },
  });

  assert.equal(result.status, "sent");
  assert.match(inputs[0] ?? "", /Harness 任务已阻塞/);
  assert.match(inputs[0] ?? "", /audit failed on final round 3/);
});

test("notification command receives stdin and deliveries are deduplicated with reminders", (t) => {
  const fixture = createFixture(t, 3);
  const inputs: string[] = [];
  const execute = (
    _command: string,
    _args: string[],
    options: { input?: string } = {},
  ): ExecResult => {
    inputs.push(options.input ?? "");
    return { ok: true, code: 0, stdout: "{}", stderr: "" };
  };

  const first = notifyActiveIntervention({
    ...fixture,
    now: new Date("2026-07-29T00:01:00Z"),
    exec: execute,
  });
  const duplicate = notifyActiveIntervention({
    ...fixture,
    now: new Date("2026-07-29T00:02:00Z"),
    exec: execute,
  });
  const reminder = notifyActiveIntervention({
    ...fixture,
    now: new Date("2026-07-29T00:31:00Z"),
    exec: execute,
  });

  assert.equal(first.status, "sent");
  assert.equal(duplicate.status, "not_due");
  assert.equal(reminder.status, "sent");
  assert.equal(reminder.reminderMinutes, 30);
  assert.equal(inputs.length, 2);
});

test("failed notification retries are bounded per reminder", (t) => {
  const fixture = createFixture(t, 2);
  let calls = 0;
  const fail = (): ExecResult => {
    calls += 1;
    return { ok: false, code: 1, stdout: "", stderr: "offline" };
  };

  const one = notifyActiveIntervention({ ...fixture, now: new Date(observedAt), exec: fail });
  const two = notifyActiveIntervention({ ...fixture, now: new Date(observedAt), exec: fail });
  const exhausted = notifyActiveIntervention({ ...fixture, now: new Date(observedAt), exec: fail });

  assert.equal(one.status, "failed");
  assert.equal(two.status, "failed");
  assert.equal(exhausted.status, "not_due");
  assert.equal(calls, 2);
});

test("opt-in lifecycle updates send once without alert reminders", (t) => {
  const fixture = createFixture(t, 2, ["merged"]);
  const ledger = new Ledger(fixture.ledgerPath);
  const job = ledger.getJob("job-1")!;
  ledger.close();
  const inputs: string[] = [];
  const exec = (_command: string, _args: string[], options: { input?: string } = {}): ExecResult => {
    inputs.push(options.input ?? "");
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const first = notifyStatusEvent({ ...fixture, event: "merged", job, exec });
  const duplicate = notifyStatusEvent({ ...fixture, event: "merged", job, exec });
  assert.equal(first.status, "sent");
  assert.equal(duplicate.status, "not_due");
  assert.equal(inputs.length, 1);
  assert.match(inputs[0]!, /Harness 状态更新/);
  assert.match(renderStatusNotification(job, "merged"), /PR 已合并/);
});

function createFixture(
  t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never,
  maxAttempts: number,
  statusEvents: string[] = [],
): { configPath: string; ledgerPath: string; lockPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "harness-notification-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "harness.yaml");
  const ledgerPath = join(dir, "harness.sqlite");
  const lockPath = join(dir, "harness.lock");
  writeFileSync(
    configPath,
    `version: 1
issueLabel: ready-for-agent
notifications:
  enabled: true
  command: [notify-test]
  reminderMinutes: [0, 30, 120]
  maxAttemptsPerReminder: ${maxAttempts}
  statusEvents: ${JSON.stringify(statusEvents)}
repositories:
  - github: owner/repo
    baseRef: origin/main
    defaultBranch: main
`,
  );
  const ledger = new Ledger(ledgerPath);
  const claim = ledger.tryClaim({
    id: "job-1",
    project: testProject(),
    issue: {
      number: 20,
      title: "Account audit",
      url: "https://example.test/issues/20",
      updatedAt: observedAt,
      blockedBy: [],
      labels: ["ready-for-agent"],
    },
    baseSha: "base123",
    implementerProfileId: "codex-default",
  });
  assert.equal(claim.ok, true);
  ledger.updateJob("job-1", {
    state: "blocked",
    intervention_json: JSON.stringify(intervention()),
    last_error: "worker requested a human decision",
    head_sha: "abc123",
  });
  ledger.close();
  return { configPath, ledgerPath, lockPath };
}
