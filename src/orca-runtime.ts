import type { AgentProfile, HarnessConfig, RepoConfig } from "./types.js";
import { orcaJson, unwrapResult } from "./orca.js";

export type WorktreeCreateResult = {
  worktreeId: string;
  worktreePath: string;
  agentTerminalHandle: string | null;
  branch: string | null;
  raw: unknown;
};

export type TaskCreateResult = {
  taskId: string;
  raw: unknown;
};

export type DispatchResult = {
  dispatchId: string | null;
  raw: unknown;
};

export type OrchestrationMessage = {
  id?: string;
  type?: string;
  taskId?: string;
  dispatchId?: string;
  payload?: unknown;
  body?: string;
  subject?: string;
  [key: string]: unknown;
};

export function ensureControllerTerminal(
  orcaCli: string,
  config: HarnessConfig,
): { ok: true; handle: string } | { ok: false; error: string } {
  const title = config.orca.controllerTitle;
  const path = config.orca.controllerWorktreePath;

  const listed = orcaJson(orcaCli, [
    "terminal",
    "list",
    "--worktree",
    `path:${path}`,
  ]);
  if (listed.ok && listed.data) {
    const result = unwrapResult<{ terminals?: Array<{ handle: string; title?: string; connected?: boolean }> }>(
      listed.data,
    );
    const match = (result.terminals ?? []).find(
      (t) => t.title === title && t.connected !== false,
    );
    if (match?.handle) {
      return { ok: true, handle: match.handle };
    }
  }

  const created = orcaJson(orcaCli, [
    "terminal",
    "create",
    "--worktree",
    `path:${path}`,
    "--title",
    title,
    "--command",
    "zsh",
  ]);
  if (!created.ok || !created.data) {
    return { ok: false, error: created.error ?? "controller terminal create failed" };
  }
  const result = unwrapResult<{
    handle?: string;
    terminal?: { handle?: string };
  }>(created.data);
  const handle = result.handle ?? result.terminal?.handle;
  if (!handle) {
    return {
      ok: false,
      error: `controller terminal create returned no handle: ${created.raw.slice(0, 500)}`,
    };
  }
  return { ok: true, handle };
}

export function ensureIssueWorktree(
  orcaCli: string,
  repo: RepoConfig,
  issueNumber: number,
  profile: AgentProfile,
): { ok: true; value: WorktreeCreateResult } | { ok: false; error: string } {
  const name = `issue-${issueNumber}`;

  // Reuse existing worktree for this issue if present.
  const listed = orcaJson(orcaCli, [
    "worktree",
    "list",
    "--repo",
    `id:${repo.orcaRepoId}`,
  ]);
  if (listed.ok && listed.data) {
    const result = unwrapResult<{
      worktrees?: Array<{
        id: string;
        path: string;
        displayName?: string;
        branch?: string;
        linkedIssue?: number | null;
      }>;
    }>(listed.data);
    const existing = (result.worktrees ?? []).find(
      (w) =>
        w.linkedIssue === issueNumber ||
        w.displayName === name ||
        w.displayName === `issue-${issueNumber}` ||
        w.path?.includes(`/issue-${issueNumber}`),
    );
    if (existing) {
      const terms = orcaJson(orcaCli, [
        "terminal",
        "list",
        "--worktree",
        `id:${existing.id}`,
      ]);
      let agentHandle: string | null = null;
      if (terms.ok && terms.data) {
        const tr = unwrapResult<{
          terminals?: Array<{ handle: string; title?: string; preview?: string }>;
        }>(terms.data);
        // Prefer a terminal that looks like the agent.
        const agentish = (tr.terminals ?? []).find((t) =>
          (t.title ?? "").toLowerCase().includes(profile.orcaAgent),
        );
        agentHandle =
          agentish?.handle ?? tr.terminals?.[0]?.handle ?? null;
      }
      return {
        ok: true,
        value: {
          worktreeId: existing.id,
          worktreePath: existing.path,
          agentTerminalHandle: agentHandle,
          branch: existing.branch ?? null,
          raw: existing,
        },
      };
    }
  }

  const args = [
    "worktree",
    "create",
    "--repo",
    `id:${repo.orcaRepoId}`,
    "--name",
    name,
    "--no-parent",
    "--base-branch",
    repo.baseRef,
    "--issue",
    String(issueNumber),
    "--agent",
    profile.orcaAgent,
    "--setup",
    "skip",
    "--comment",
    `harness: claimed #${issueNumber}`,
  ];

  const created = orcaJson(orcaCli, args, { timeoutMs: 120_000 });
  if (!created.ok || !created.data) {
    return { ok: false, error: created.error ?? "worktree create failed" };
  }

  const result = unwrapResult<{
    worktree?: { id?: string; path?: string; branch?: string };
    agentTerminalHandle?: string;
    startupTerminal?: { handle?: string };
  }>(created.data);

  const worktreeId = result.worktree?.id;
  const worktreePath = result.worktree?.path;
  const agentTerminalHandle =
    result.agentTerminalHandle ??
    result.startupTerminal?.handle ??
    null;

  if (!worktreeId || !worktreePath) {
    return {
      ok: false,
      error: `worktree create missing id/path: ${created.raw.slice(0, 800)}`,
    };
  }

  return {
    ok: true,
    value: {
      worktreeId,
      worktreePath,
      agentTerminalHandle,
      branch: result.worktree?.branch ?? null,
      raw: created.data,
    },
  };
}

export function setWorktreeProgress(
  orcaCli: string,
  worktreeId: string,
  comment: string,
  workspaceStatus?: "todo" | "in-progress" | "in-review" | "completed",
): void {
  const args = [
    "worktree",
    "set",
    "--worktree",
    `id:${worktreeId}`,
    "--comment",
    comment,
  ];
  if (workspaceStatus) {
    args.push("--workspace-status", workspaceStatus);
  }
  // Best-effort visibility; do not fail the pipeline.
  orcaJson(orcaCli, args);
}

export function waitTerminalIdle(
  orcaCli: string,
  handle: string,
  timeoutMs = 60_000,
): { ok: boolean; error?: string } {
  const r = orcaJson(
    orcaCli,
    [
      "terminal",
      "wait",
      "--terminal",
      handle,
      "--for",
      "tui-idle",
      "--timeout-ms",
      String(timeoutMs),
    ],
    { timeoutMs: timeoutMs + 5_000 },
  );
  if (!r.ok) {
    return { ok: false, error: r.error ?? "terminal wait failed" };
  }
  return { ok: true };
}

export function createOrchestrationTask(
  orcaCli: string,
  input: { title: string; displayName: string; spec: string },
): { ok: true; value: TaskCreateResult } | { ok: false; error: string } {
  const r = orcaJson(orcaCli, [
    "orchestration",
    "task-create",
    "--task-title",
    input.title,
    "--display-name",
    input.displayName,
    "--spec",
    input.spec,
  ]);
  if (!r.ok || !r.data) {
    return { ok: false, error: r.error ?? "task-create failed" };
  }
  const result = unwrapResult<{
    taskId?: string;
    task?: { id?: string };
    id?: string;
  }>(r.data);
  const taskId = result.taskId ?? result.task?.id ?? result.id;
  if (!taskId) {
    return {
      ok: false,
      error: `task-create missing taskId: ${r.raw.slice(0, 800)}`,
    };
  }
  return { ok: true, value: { taskId, raw: r.data } };
}

export function dispatchTask(
  orcaCli: string,
  input: { taskId: string; to: string; from: string },
): { ok: true; value: DispatchResult } | { ok: false; error: string } {
  const r = orcaJson(orcaCli, [
    "orchestration",
    "dispatch",
    "--task",
    input.taskId,
    "--to",
    input.to,
    "--from",
    input.from,
    "--inject",
  ]);
  if (!r.ok || !r.data) {
    return { ok: false, error: r.error ?? "dispatch failed" };
  }
  const result = unwrapResult<{
    dispatchId?: string;
    dispatch?: { id?: string };
    id?: string;
  }>(r.data);
  const dispatchId =
    result.dispatchId ?? result.dispatch?.id ?? result.id ?? null;
  return { ok: true, value: { dispatchId, raw: r.data } };
}

export function waitWorkerDone(
  orcaCli: string,
  input: {
    controllerHandle: string;
    taskId: string;
    dispatchId: string | null;
    timeoutMs: number;
    onTick?: (info: string) => void;
  },
): {
  ok: true;
  message: OrchestrationMessage;
} | {
  ok: false;
  error: string;
  escalated?: boolean;
  message?: OrchestrationMessage;
} {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const slice = Math.min(60_000, Math.max(5_000, deadline - Date.now()));
    input.onTick?.(
      `waiting worker_done (slice ${Math.round(slice / 1000)}s, task ${input.taskId})`,
    );
    const r = orcaJson(
      orcaCli,
      [
        "orchestration",
        "check",
        "--terminal",
        input.controllerHandle,
        "--wait",
        "--types",
        "worker_done,escalation,decision_gate",
        "--timeout-ms",
        String(slice),
      ],
      { timeoutMs: slice + 10_000 },
    );

    const messages = extractMessages(r.data);
    for (const msg of messages) {
      const type = String(msg.type ?? msg.messageType ?? "").toLowerCase();
      const taskId = String(
        msg.taskId ??
          (msg.payload as { taskId?: string } | undefined)?.taskId ??
          "",
      );
      const dispatchId = String(
        msg.dispatchId ??
          (msg.payload as { dispatchId?: string } | undefined)?.dispatchId ??
          "",
      );

      // Prefer matching taskId; if payload lacks it, accept any worker_done while we own one task.
      const taskMatches = !taskId || taskId === input.taskId;
      const dispatchMatches =
        !input.dispatchId || !dispatchId || dispatchId === input.dispatchId;

      if (type.includes("escalation") && taskMatches) {
        return {
          ok: false,
          error: "worker sent escalation",
          escalated: true,
          message: msg,
        };
      }
      if (type.includes("decision_gate") && taskMatches) {
        return {
          ok: false,
          error: "worker raised decision_gate (unsupported in M2 auto path)",
          message: msg,
        };
      }
      if (type.includes("worker_done") && taskMatches && dispatchMatches) {
        return { ok: true, message: msg };
      }
    }

    // timeout / empty → continue until deadline
    if (Date.now() >= deadline) break;
  }

  return {
    ok: false,
    error: `timeout waiting for worker_done on task ${input.taskId}`,
  };
}

export function worktreePs(orcaCli: string): unknown {
  const r = orcaJson(orcaCli, ["worktree", "ps"]);
  return r.data ?? { error: r.error };
}

export function taskList(orcaCli: string): unknown {
  const r = orcaJson(orcaCli, ["orchestration", "task-list"]);
  return r.data ?? { error: r.error };
}

function extractMessages(data: unknown): OrchestrationMessage[] {
  if (!data) return [];
  const result = unwrapResult<{
    messages?: OrchestrationMessage[];
    message?: OrchestrationMessage;
    count?: number;
  }>(data);
  if (Array.isArray(result.messages)) return result.messages;
  if (result.message) return [result.message];
  // some shapes put array at top-level result
  if (Array.isArray(result)) return result as OrchestrationMessage[];
  return [];
}
