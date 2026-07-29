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
import { Ledger } from "../src/ledger.js";
import { resolveWorkerIntervention } from "../src/recovery.js";
import { testProject } from "./support.js";
import type { RecoverAction } from "../src/reconcile.js";
import type { RuntimeHarnessConfig } from "../src/types.js";

test("acknowledged completed escalation advances only the exact clean committed task", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-intervention-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktree = join(dir, "worktree");
  mkdirSync(worktree);
  git(worktree, "init", "-b", "agent/issue-1");
  git(worktree, "config", "user.name", "Harness Test");
  git(worktree, "config", "user.email", "harness@example.test");
  writeFileSync(join(worktree, "file.txt"), "base\n");
  git(worktree, "add", "file.txt");
  git(worktree, "commit", "-m", "base");
  const baseSha = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "file.txt"), "done\n");
  git(worktree, "add", "file.txt");
  git(worktree, "commit", "-m", "done");
  const headSha = git(worktree, "rev-parse", "HEAD");

  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  t.after(() => ledger.close());
  const project = testProject();
  project.localPath = worktree;
  const claimed = ledger.tryClaim({
    id: "job-1",
    project,
    issue: {
      number: 1,
      title: "intervention",
      url: "https://example.test/issues/1",
      updatedAt: "2026-07-29T00:00:00Z",
      blockedBy: [],
      labels: ["ready-for-agent"],
    },
    baseRef: "origin/main",
    baseSha,
    implementerProfileId: "pi-implementer",
  });
  assert.equal(claimed.ok, true);
  const blocked = ledger.updateJob("job-1", {
    state: "blocked",
    worktree_id: "worktree-1",
    worktree_path: worktree,
    implementer_task_id: "task-1",
    implementer_dispatch_id: "dispatch-1",
    head_sha: headSha,
    last_error: "worker sent escalation",
    intervention_json: JSON.stringify({
      version: 1,
      kind: "escalation",
      sourceState: "implementing",
      role: "implementer",
      messageId: "message-1",
      taskId: "task-1",
      dispatchId: "dispatch-1",
      headSha,
      body: "scope needs confirmation",
      payload: null,
      observedAt: "2026-07-29T00:00:00Z",
    }),
  });
  const action: Extract<RecoverAction, { kind: "resolve_intervention" }> = {
    kind: "resolve_intervention",
    intervention: "escalation",
    reason: "acknowledge",
  };
  const base = {
    ok: true,
    message: action.reason,
    action,
    jobId: blocked.id,
    executed: false,
  };

  const mismatch = resolveWorkerIntervention({
    action,
    job: { ...blocked, implementer_task_id: "task-other" },
    hints: {
      worktreeExists: true,
      currentHeadSha: headSha,
      baseIsAncestor: true,
      trackedClean: true,
      hasCommitsSinceBase: true,
      implementTaskStatus: "completed",
    },
    ledger,
    config: {} as RuntimeHarnessConfig,
    acknowledgeEscalation: true,
    base,
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.message, /no longer matches/);
  assert.equal(ledger.getJob("job-1")?.state, "blocked");

  const movedHead = resolveWorkerIntervention({
    action,
    job: ledger.getJob("job-1")!,
    hints: {
      worktreeExists: true,
      currentHeadSha: baseSha,
      baseIsAncestor: true,
      trackedClean: true,
      hasCommitsSinceBase: true,
      implementTaskStatus: "completed",
    },
    ledger,
    config: {} as RuntimeHarnessConfig,
    acknowledgeEscalation: true,
    base,
  });
  assert.equal(movedHead.ok, false);
  assert.match(movedHead.message, /HEAD changed after intervention/);
  assert.equal(ledger.getJob("job-1")?.state, "blocked");

  const resolved = resolveWorkerIntervention({
    action,
    job: ledger.getJob("job-1")!,
    hints: {
      worktreeExists: true,
      currentHeadSha: headSha,
      baseIsAncestor: true,
      trackedClean: true,
      hasCommitsSinceBase: true,
      implementTaskStatus: "completed",
    },
    ledger,
    config: {} as RuntimeHarnessConfig,
    acknowledgeEscalation: true,
    base,
  });
  assert.equal(resolved.ok, true, resolved.message);
  assert.equal(ledger.getJob("job-1")?.state, "awaiting_audit");
  assert.equal(ledger.getJob("job-1")?.head_sha, headSha);
  assert.ok(ledger.getJob("job-1")?.intervention_resolved_at);
});

test("decision recovery sends only the human reply and restores the exact task state", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-decision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktree = join(dir, "worktree");
  mkdirSync(worktree);
  git(worktree, "init", "-b", "agent/issue-2");
  git(worktree, "config", "user.name", "Harness Test");
  git(worktree, "config", "user.email", "harness@example.test");
  writeFileSync(join(worktree, "file.txt"), "base\n");
  git(worktree, "add", "file.txt");
  git(worktree, "commit", "-m", "base");
  const headSha = git(worktree, "rev-parse", "HEAD");

  const ledger = new Ledger(join(dir, "ledger.sqlite"));
  t.after(() => ledger.close());
  const project = testProject();
  project.localPath = worktree;
  assert.equal(
    ledger.tryClaim({
      id: "job-2",
      project,
      issue: {
        number: 2,
        title: "decision",
        url: "https://example.test/issues/2",
        updatedAt: "2026-07-29T00:00:00Z",
        blockedBy: [],
        labels: ["ready-for-agent"],
      },
      baseRef: "origin/main",
      baseSha: headSha,
      implementerProfileId: "pi-implementer",
    }).ok,
    true,
  );
  const blocked = ledger.updateJob("job-2", {
    state: "blocked",
    worktree_id: "worktree-2",
    worktree_path: worktree,
    controller_terminal_handle: "controller-1",
    implementer_task_id: "task-2",
    implementer_dispatch_id: "dispatch-2",
    head_sha: headSha,
    last_error: "worker requested a human decision",
    intervention_json: JSON.stringify({
      version: 1,
      kind: "decision_gate",
      sourceState: "implementing",
      role: "implementer",
      messageId: "gate-2",
      taskId: "task-2",
      dispatchId: "dispatch-2",
      headSha,
      body: "May I widen the migration scope?",
      payload: null,
      observedAt: "2026-07-29T00:00:00Z",
    }),
  });
  const callsPath = join(dir, "calls.json");
  const fakeOrca = join(dir, "orca.cjs");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ ok: true, result: {} }));
`,
  );
  chmodSync(fakeOrca, 0o755);
  const action: Extract<RecoverAction, { kind: "resolve_intervention" }> = {
    kind: "resolve_intervention",
    intervention: "decision_gate",
    reason: "reply",
  };
  const resolved = resolveWorkerIntervention({
    action,
    job: blocked,
    hints: {
      worktreeExists: true,
      currentHeadSha: headSha,
      baseIsAncestor: true,
      trackedClean: true,
      implementTaskStatus: "working",
    },
    ledger,
    config: {
      orca: {
        cliPath: fakeOrca,
        cliPathFallback: fakeOrca,
        controllerTitle: "controller",
      },
    } as RuntimeHarnessConfig,
    decisionReply: "No. Keep the original issue scope.",
    base: {
      ok: true,
      message: action.reason,
      action,
      jobId: blocked.id,
      executed: false,
    },
  });

  assert.equal(resolved.ok, true, resolved.message);
  assert.equal(ledger.getJob("job-2")?.state, "implementing");
  assert.deepEqual(JSON.parse(readFileSync(callsPath, "utf8")), [
    "orchestration",
    "reply",
    "--id",
    "gate-2",
    "--body",
    "No. Keep the original issue scope.",
    "--from",
    "controller-1",
    "--json",
  ]);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
