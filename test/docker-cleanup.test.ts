import test from "node:test";
import assert from "node:assert/strict";
import { cleanupHarnessDocker } from "../src/docker-cleanup.js";
import type { ExecResult } from "../src/exec.js";
import type { Job } from "../src/types.js";

test("plans only exact terminal worktree Compose resources", () => {
  const calls: string[][] = [];
  const items = cleanupHarnessDocker(
    [job({ id: "done", state: "merged", issue: 6, worktree: "/work/issue-6" }), job({ id: "active", state: "auditing", issue: 33, worktree: "/work/issue-33" })],
    { dryRun: true },
    fakeDocker(calls, [
      container("done-c", "done-project", "/work/issue-6"),
      container("active-c", "active-project", "/work/issue-33"),
      container("unknown-c", "unknown-project", "/work/unrelated"),
    ]),
  );

  assert.deepEqual(items.map((item) => item.project), ["done-project"]);
  assert.equal(items[0]?.executed, false);
  assert.ok(calls.some((args) => args.some((arg) => arg.includes("done-project"))));
  assert.ok(!calls.some((args) => args.some((arg) => arg.includes("active-project"))));
});

test("legacy mode recognizes only the canonical Orca issue path", () => {
  const jobs = [
    job({ id: "old", state: "merged", issue: 17, worktree: null }),
    job({ id: "current", state: "auditing", issue: 33, worktree: "/work/issue-33" }),
  ];
  const containers = [
    container("old-c", "legacy-project", "/Users/yet/orca/workspaces/Exposure-Agent/issue-17"),
    container("wrong-c", "wrong-project", "/Users/yet/orca/workspaces/Exposure-Agent/issue-18"),
    container("current-c", "current-project", "/Users/yet/orca/workspaces/Exposure-Agent/issue-33"),
  ];

  assert.equal(cleanupHarnessDocker(jobs, { dryRun: true }, fakeDocker([], containers)).length, 0);
  const items = cleanupHarnessDocker(jobs, { dryRun: true, legacy: true }, fakeDocker([], containers));
  assert.deepEqual(items.map((item) => item.project), ["legacy-project"]);
  assert.match(items[0]?.message ?? "", /legacy/);
});

test("execute removes exact containers before labelled networks and volumes", () => {
  const calls: string[][] = [];
  const items = cleanupHarnessDocker(
    [job({ id: "done", state: "cancelled", issue: 26, worktree: "/work/issue-26" })],
    { dryRun: false },
    fakeDocker(calls, [container("container-1", "issue26", "/work/issue-26")]),
  );

  assert.equal(items[0]?.ok, true);
  assert.deepEqual(calls.slice(-3), [
    ["rm", "-f", "container-1"],
    ["network", "rm", "network-1"],
    ["volume", "rm", "volume-1"],
  ]);
});

function fakeDocker(calls: string[][], containers: unknown[]) {
  return (_command: string, args: string[]): ExecResult => {
    calls.push(args);
    if (args[0] === "ps") return ok(containers.map((_, i) => `id-${i + 1}`).join("\n"));
    if (args[0] === "inspect") return ok(JSON.stringify(containers));
    if (args[0] === "volume" && args[1] === "ls") return ok("volume-1\n");
    if (args[0] === "network" && args[1] === "ls") return ok("network-1\n");
    return ok("");
  };
}

function container(id: string, project: string, worktree: string) {
  return { Id: id, Config: { Labels: {
    "com.docker.compose.project": project,
    "com.docker.compose.project.working_dir": worktree,
  } } };
}

function ok(stdout: string): ExecResult {
  return { ok: true, code: 0, stdout, stderr: "" };
}

function job(input: { id: string; state: Job["state"]; issue: number; worktree: string | null }): Job {
  return {
    id: input.id, repo: "notyet1307/exposure-agent", issue_number: input.issue,
    issue_url: "https://example.test/issues/1", issue_updated_at: "2026-07-30T00:00:00Z", issue_snapshot_json: "{}",
    project_key: null, project_revision: null, project_snapshot_json: null, state: input.state,
    base_ref: "origin/main", base_sha: null, branch: null, worktree_id: null, worktree_path: input.worktree,
    implementer_profile_id: null, implementer_terminal_handle: null, implementer_task_id: null, implementer_dispatch_id: null,
    auditor_profile_id: null, auditor_terminal_handle: null, auditor_task_id: null, auditor_dispatch_id: null,
    dispatch_attempt: 0, dispatch_probe_pending: 0, controller_terminal_handle: null, audit_round: 0,
    audit_result_json: null, audit_head_sha: null, pr_number: null, pr_url: null, merged_at: null, last_error: null,
    intervention_json: null, intervention_resolved_at: null, head_sha: null, revision: 1,
    created_at: "2026-07-30T00:00:00Z", updated_at: "2026-07-30T00:00:00Z",
  };
}
