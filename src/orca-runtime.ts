import { basename } from "node:path";
import type { AgentProfile, HarnessConfig, RepoConfig } from "./types.js";
import { orcaJson, unwrapResult } from "./orca.js";
import { execFile } from "./exec.js";
import {
  verdictDispatchAccepted,
  type TerminalProbeSnapshot,
} from "./dispatch-probe.js";

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
  dispatchId: string;
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

const DECISION_GATE_REPLY =
  "Continue within the assigned task, scope, and restrictions. Use your best judgment and choose the safest minimal approach.";

type DispatchAttemptFailure = {
  ok: false;
  error: string;
  kind: "retryable" | "interactive" | "unknown";
  attempt: 1 | 2;
  taskId?: string;
  dispatchId?: string | null;
};

type LastDispatchProvenance = {
  lastTaskId?: string;
  lastDispatchId?: string | null;
  lastAttempt?: 1 | 2;
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
):
  | { ok: true; value: WorktreeCreateResult }
  | { ok: false; error: string; retryable?: boolean } {
  const name = `issue-${issueNumber}`;

  // Reuse existing worktree for this issue if present.
  const listed = orcaJson(orcaCli, [
    "worktree",
    "list",
    "--repo",
    `id:${repo.orcaRepoId}`,
  ]);
  if (!listed.ok || !listed.data) {
    return {
      ok: false,
      error: `Orca worktree list failed: ${listed.error ?? "missing response"}`,
      retryable: true,
    };
  }
  const listResult = unwrapResult<{
    worktrees?: Array<{
      id: string;
      path: string;
      displayName?: string;
      branch?: string;
      linkedIssue?: number | null;
      workspaceStatus?: string;
    }>;
    totalCount?: unknown;
    truncated?: unknown;
  }>(listed.data);
  if (listResult.truncated === true) {
    return {
      ok: false,
      error: "truncated worktree list cannot prove issue worktree absence",
    };
  }
  if (
    listResult.truncated !== false ||
    !Number.isInteger(listResult.totalCount) ||
    (listResult.totalCount as number) < 0
  ) {
    return {
      ok: false,
      error:
        "invalid worktree list completeness metadata: " +
        "expected truncated=false and a non-negative integer totalCount",
    };
  }
  if (!Array.isArray(listResult.worktrees)) {
    return {
      ok: false,
      error:
        "invalid worktree list: " +
        "result.worktrees is not an array",
    };
  }
  if (listResult.totalCount !== listResult.worktrees.length) {
    return {
      ok: false,
      error:
        `worktree list totalCount=${listResult.totalCount} ` +
        `does not match ${listResult.worktrees.length} returned entries`,
    };
  }
  const invalidIndex = listResult.worktrees.findIndex(
    (worktree) =>
      !worktree ||
      typeof worktree.id !== "string" ||
      !worktree.id.trim() ||
      typeof worktree.path !== "string" ||
      !worktree.path.trim() ||
      (worktree.displayName != null &&
        typeof worktree.displayName !== "string") ||
      (worktree.branch != null && typeof worktree.branch !== "string") ||
      (worktree.linkedIssue != null &&
        (!Number.isInteger(worktree.linkedIssue) ||
          worktree.linkedIssue < 1)) ||
      (worktree.workspaceStatus != null &&
        typeof worktree.workspaceStatus !== "string"),
  );
  if (invalidIndex !== -1) {
    return {
      ok: false,
      error: `invalid worktree list entry at index ${invalidIndex}`,
    };
  }
  const matches = listResult.worktrees.filter(
    (worktree) =>
      worktree.linkedIssue === issueNumber ||
      (worktree.linkedIssue == null &&
        (worktree.displayName === name ||
          basename(worktree.path) === name)),
  );
  if (matches.length > 1) {
    return {
      ok: false,
      error:
        `multiple worktrees match issue #${issueNumber}: ` +
        matches.map((worktree) => worktree.id).join(", "),
    };
  }
  const existing = matches[0];
  if (existing) {
    if (existing.workspaceStatus === "completed") {
      return {
        ok: false,
        error:
          `completed worktree already exists for issue #${issueNumber}: ` +
          existing.id,
      };
    }
    const agentHandle = ensureAgentTerminal(
      orcaCli,
      existing.id,
      profile,
      `issue-${issueNumber}-${profile.orcaAgent}`,
    );
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

  // Create worktree WITHOUT --agent first. On this machine, combining
  // --agent codex with worktree create repeatedly closed the Orca runtime.
  // Launch the implementer terminal in a second step instead.
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

  if (!worktreeId || !worktreePath) {
    return {
      ok: false,
      error: `worktree create missing id/path: ${created.raw.slice(0, 800)}`,
    };
  }

  const agentTerminalHandle = ensureAgentTerminal(
    orcaCli,
    worktreeId,
    profile,
    `issue-${issueNumber}-${profile.orcaAgent}`,
  );

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

/** Start or reuse an agent terminal inside an existing worktree. */
/**
 * Always create a fresh terminal for a named role session when forceNew is true
 * (recommended for each audit round to avoid context anchoring).
 */
export function ensureAgentTerminal(
  orcaCli: string,
  worktreeId: string,
  profile: AgentProfile,
  title: string,
  options: { forceNew?: boolean } = {},
): string | null {
  if (!options.forceNew) {
    const listed = orcaJson(orcaCli, [
      "terminal",
      "list",
      "--worktree",
      `id:${worktreeId}`,
    ]);
    if (listed.ok && listed.data) {
      const result = unwrapResult<{
        terminals?: Array<{
          handle: string;
          title?: string;
          connected?: boolean;
        }>;
      }>(listed.data);
      const matches = (result.terminals ?? []).filter(
        (terminal) =>
          terminal.connected !== false && terminal.title === title,
      );
      if (matches.length === 1) return matches[0]!.handle;
    }
  }

  const command = profile.command ?? profile.orcaAgent;
  const created = orcaJson(
    orcaCli,
    [
      "terminal",
      "create",
      "--worktree",
      `id:${worktreeId}`,
      "--title",
      title,
      "--command",
      command,
    ],
    { timeoutMs: 90_000 },
  );
  if (!created.ok || !created.data) return null;
  const result = unwrapResult<{
    handle?: string;
    terminal?: { handle?: string };
  }>(created.data);
  return result.handle ?? result.terminal?.handle ?? null;
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
): {
  ok: boolean;
  error?: string;
  satisfied?: boolean;
  blockedReason?: string | null;
} {
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
  const wait = extractWait(r.data);
  if (wait.satisfied == null) {
    return {
      ok: false,
      error: r.error ?? "terminal wait missing result.wait.satisfied",
      ...wait,
    };
  }
  // satisfied true = became idle; false = timed out still busy
  return {
    ok: true,
    satisfied: wait.satisfied,
    blockedReason: wait.blockedReason,
  };
}

export function probeTerminal(
  orcaCli: string,
  handle: string,
  cursor: string | null = null,
): TerminalProbeSnapshot {
  let title = "";
  let preview = "";
  let tailText = "";
  let idle: boolean | null = null;
  let blockedReason: string | null = null;
  let observed = false;

  const shown = orcaJson(orcaCli, ["terminal", "show", "--terminal", handle]);
  if (shown.ok && shown.data) {
    observed = true;
    const result = unwrapResult<{
      terminal?: {
        title?: string;
        preview?: string;
        handle?: string;
      };
      title?: string;
      preview?: string;
    }>(shown.data);
    const t = result.terminal ?? result;
    title = String(t.title ?? "");
    preview = String(t.preview ?? "");
  }

  const readArgs = ["terminal", "read", "--terminal", handle];
  if (cursor) readArgs.push("--cursor", cursor);
  const read = orcaJson(orcaCli, readArgs);
  if (read.ok && read.data) {
    observed = true;
    const result = unwrapResult<{
      terminal?: { tail?: string[]; title?: string; preview?: string };
    }>(read.data);
    const tail = result.terminal?.tail ?? [];
    tailText = tail.join("\n");
    if (!title && result.terminal?.title) title = result.terminal.title;
    if (!preview && result.terminal?.preview) {
      preview = result.terminal.preview;
    }
  }

  // Short non-blocking-ish idle probe (2s)
  const idleProbe = waitTerminalIdle(orcaCli, handle, 2_000);
  if (idleProbe.satisfied === true) {
    observed = true;
    idle = true;
    blockedReason = idleProbe.blockedReason ?? null;
  } else if (idleProbe.satisfied === false) {
    observed = true;
    idle = false;
    blockedReason = idleProbe.blockedReason ?? null;
  } else if (idleProbe.blockedReason) {
    blockedReason = idleProbe.blockedReason;
  }

  // list may have fresher title/preview
  // (optional — already have show/read)

  return {
    title,
    preview,
    tailText,
    freshOutput: Boolean(cursor && read.ok),
    observed,
    idle,
    blockedReason,
  };
}

/**
 * After dispatch --inject, poll until the agent shows acceptance signals
 * or the window expires.
 */
export function awaitDispatchAccepted(
  orcaCli: string,
  handle: string,
  taskId: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    cursor?: string | null;
    onTick?: (info: string) => void;
  } = {},
): {
  accepted: boolean;
  reason: string;
  interactive?: boolean;
  retryable?: boolean;
  unknown?: boolean;
} {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const pollMs = options.pollMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  let lastReason = "probe window not started";
  let sawIdle = false;
  let sawObservation = false;

  while (Date.now() < deadline) {
    const snap = probeTerminal(orcaCli, handle, options.cursor ?? null);
    const verdict = verdictDispatchAccepted(snap, taskId);
    sawIdle ||= snap.idle === true;
    sawObservation ||= snap.observed;
    lastReason = verdict.reason;
    options.onTick?.(
      `dispatch-probe: accepted=${verdict.accepted} — ${verdict.reason}`,
    );
    if (verdict.accepted) {
      return {
        accepted: true,
        reason: verdict.reason,
      };
    }
    if ("interactive" in verdict && verdict.interactive) {
      return {
        accepted: false,
        reason: verdict.reason,
        interactive: true,
      };
    }
    if ("retryable" in verdict && verdict.retryable) {
      return {
        accepted: false,
        reason: verdict.reason,
        retryable: true,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    sleepMs(Math.min(pollMs, remaining));
  }

  if (sawIdle) {
    return { accepted: false, reason: lastReason, retryable: true };
  }
  return {
    accepted: false,
    reason: sawObservation
      ? `${lastReason}; terminal never confirmed idle`
      : "terminal acceptance probe unavailable",
    unknown: true,
  };
}

export function failOrchestrationTask(
  orcaCli: string,
  taskId: string,
): { ok: true } | { ok: false; error: string } {
  const result = orcaJson(orcaCli, [
    "orchestration",
    "task-update",
    "--id",
    taskId,
    "--status",
    "failed",
  ]);
  return result.ok
    ? { ok: true }
    : { ok: false, error: result.error ?? "task-update failed" };
}

export type DispatchWait =
  | { kind: "terminal_idle"; to: string }
  | {
      kind: "dispatch_acceptance";
      to: string;
      taskId: string;
      dispatchId: string | null;
      attempt: 1 | 2;
    };

/**
 * Create task + dispatch + confirm agent started.
 * On silent-idle failure: fail task, optionally new terminal, one automatic re-dispatch.
 */
export function dispatchTaskEnsured(
  orcaCli: string,
  input: {
    title: string;
    displayName: string;
    spec: string;
    to: string;
    from: string;
    /** Probe window after each dispatch. Default 45s. */
    probeTimeoutMs?: number;
    /** Agent must reach tui-idle before a task is created. */
    idleTimeoutMs?: number;
    onLog?: (line: string) => void;
    /** Persist dispatch provenance before acceptance probing begins. */
    onDispatched?: (event: {
      taskId: string;
      dispatchId: string | null;
      to: string;
      attempt: 1 | 2;
    }) => void;
    /** Resume the acceptance probe for provenance already stored in the ledger. */
    existingDispatch?: {
      taskId: string;
      dispatchId: string | null;
      to: string;
      attempt: 1 | 2;
    };
    /** Called around terminal/acceptance waits so callers can release and reacquire locks. */
    beforeWait?: (wait: DispatchWait) => void;
    afterWait?: (wait: DispatchWait) => string | null;
    /** Final caller-owned guard immediately before each task creation. */
    beforeTaskCreate?: (attempt: 1 | 2) => string | null;
    /** Called before second attempt; return replacement agent handle or null. */
    recreateAgentTerminal?: () => string | null;
  },
):
  | {
      ok: true;
      taskId: string;
      dispatchId: string | null;
      to: string;
      attempt: 1 | 2;
      acceptReason: string;
    }
  | {
      ok: false;
      error: string;
      to: string;
      lastTaskId?: string;
      lastDispatchId?: string | null;
      lastAttempt?: 1 | 2;
      kind: "not-ready" | "interactive" | "unknown" | "exhausted";
    } {
  const log = input.onLog ?? (() => {});
  const probeTimeoutMs = input.probeTimeoutMs ?? 45_000;

  function waitWithHooks<T>(
    wait: DispatchWait,
    operation: () => T,
  ): { ok: true; value: T } | { ok: false; error: string } {
    input.beforeWait?.(wait);
    let value: T | undefined;
    let failure: unknown;
    try {
      value = operation();
    } catch (err) {
      failure = err;
    }
    const validationError = input.afterWait?.(wait) ?? null;
    if (failure) throw failure;
    if (validationError) return { ok: false, error: validationError };
    return { ok: true, value: value as T };
  }

  if (!input.existingDispatch) {
    const waited = waitWithHooks(
      { kind: "terminal_idle", to: input.to },
      () =>
        waitTerminalIdle(
          orcaCli,
          input.to,
          input.idleTimeoutMs ?? 90_000,
        ),
    );
    if (!waited.ok) {
      return {
        ok: false,
        error: waited.error,
        to: input.to,
        kind: "unknown",
      };
    }
    const ready = waited.value;
    if (!ready.ok || ready.satisfied !== true) {
      return {
        ok: false,
        error:
          ready.error ??
          ready.blockedReason ??
          "agent terminal did not reach tui-idle before dispatch",
        to: input.to,
        kind: ready.blockedReason ? "interactive" : "not-ready",
      };
    }
  }

  const probeOnce = (
    to: string,
    taskId: string,
    dispatchId: string | null,
    attempt: 1 | 2,
    cursor: string | null,
  ):
    | {
        ok: true;
        taskId: string;
        dispatchId: string | null;
        to: string;
        attempt: 1 | 2;
        acceptReason: string;
      }
    | DispatchAttemptFailure => {
    const waited = waitWithHooks(
      {
        kind: "dispatch_acceptance",
        to,
        taskId,
        dispatchId,
        attempt,
      },
      () =>
        awaitDispatchAccepted(orcaCli, to, taskId, {
          timeoutMs: probeTimeoutMs,
          cursor,
          onTick: (info) => log(info),
        }),
    );
    if (!waited.ok) {
      return {
        ok: false,
        error: waited.error,
        kind: "unknown",
        taskId,
        dispatchId,
        attempt,
      };
    }
    const accepted = waited.value;

    if (accepted.accepted) {
      log(`dispatch accepted (attempt ${attempt}): ${accepted.reason}`);
      return {
        ok: true,
        taskId,
        dispatchId,
        to,
        attempt,
        acceptReason: accepted.reason,
      };
    }

    if (accepted.interactive || accepted.unknown || !accepted.retryable) {
      return {
        ok: false,
        error: accepted.reason,
        kind: accepted.interactive ? "interactive" : "unknown",
        taskId,
        dispatchId,
        attempt,
      };
    }

    log(`dispatch NOT accepted (attempt ${attempt}): ${accepted.reason}`);
    const failed = failOrchestrationTask(orcaCli, taskId);
    if (!failed.ok) {
      return {
        ok: false,
        error: `dispatch was idle but task could not be failed: ${failed.error}`,
        kind: "unknown",
        taskId,
        dispatchId,
        attempt,
      };
    }
    return {
      ok: false,
      error: accepted.reason,
      kind: "retryable",
      taskId,
      dispatchId,
      attempt,
    };
  };

  const attemptOnce = (
    to: string,
    attempt: 1 | 2,
  ):
    | {
        ok: true;
        taskId: string;
        dispatchId: string | null;
        to: string;
        attempt: 1 | 2;
        acceptReason: string;
      }
    | DispatchAttemptFailure => {
    const cursor = terminalCursor(orcaCli, to);
    const guardError = input.beforeTaskCreate?.(attempt) ?? null;
    if (guardError) {
      return {
        ok: false,
        error: guardError,
        kind: "unknown",
        attempt,
      };
    }
    const task = createOrchestrationTask(orcaCli, {
      title:
        attempt === 1 ? input.title : `${input.title} (redispatch)`,
      displayName:
        attempt === 1
          ? input.displayName
          : `${input.displayName}-retry`,
      spec: input.spec,
    });
    if (!task.ok) {
      return {
        ok: false,
        error: task.error,
        kind: "unknown",
        attempt,
      };
    }

    log(
      `dispatch attempt ${attempt}: task=${task.value.taskId} → ${to}`,
    );
    const disp = dispatchTask(orcaCli, {
      taskId: task.value.taskId,
      to,
      from: input.from,
    });
    if (!disp.ok) {
      const failed = failOrchestrationTask(orcaCli, task.value.taskId);
      return {
        ok: false,
        error: failed.ok
          ? disp.error
          : `${disp.error}; task could not be failed: ${failed.error}`,
        kind: "unknown",
        taskId: task.value.taskId,
        dispatchId: null,
        attempt,
      };
    }

    try {
      input.onDispatched?.({
        taskId: task.value.taskId,
        dispatchId: disp.value.dispatchId,
        to,
        attempt,
      });
    } catch (err) {
      return {
        ok: false,
        error: `failed to persist dispatch provenance: ${(err as Error).message}`,
        kind: "unknown",
        taskId: task.value.taskId,
        dispatchId: disp.value.dispatchId,
        attempt,
      };
    }

    return probeOnce(
      to,
      task.value.taskId,
      disp.value.dispatchId,
      attempt,
      cursor,
    );
  };

  const existing = input.existingDispatch;
  const first = existing
    ? probeOnce(
        existing.to,
        existing.taskId,
        existing.dispatchId,
        existing.attempt,
        null,
      )
    : attemptOnce(input.to, 1);
  if (first.ok) return first;

  const firstTo = existing?.to ?? input.to;

  if (first.kind !== "retryable") {
    return {
      ok: false,
      error: first.error,
      to: firstTo,
      ...lastDispatchProvenance(first),
      kind: first.kind,
    };
  }

  if (existing?.attempt === 2) {
    return {
      ok: false,
      error: `dispatch not accepted after 2 attempts: ${first.error}`,
      to: firstTo,
      ...lastDispatchProvenance(first),
      kind: "exhausted",
    };
  }

  log(`re-dispatch after failed acceptance: ${first.error}`);

  const to = input.recreateAgentTerminal?.() ?? null;
  if (!to) {
    return {
      ok: false,
      error: "dispatch was idle but replacement agent terminal could not be created",
      to: firstTo,
      ...lastDispatchProvenance(first),
      kind: "not-ready",
    };
  }
  log(`recreated agent terminal: ${to}`);
  const waited = waitWithHooks(
    { kind: "terminal_idle", to },
    () =>
      waitTerminalIdle(
        orcaCli,
        to,
        input.idleTimeoutMs ?? 90_000,
      ),
  );
  if (!waited.ok) {
    return {
      ok: false,
      error: waited.error,
      to,
      ...lastDispatchProvenance(first),
      kind: "unknown",
    };
  }
  const idle = waited.value;
  if (!idle.ok || idle.satisfied !== true) {
    return {
      ok: false,
      error:
        idle.error ??
        idle.blockedReason ??
        "replacement agent terminal did not reach tui-idle",
      to,
      ...lastDispatchProvenance(first),
      kind: idle.blockedReason ? "interactive" : "not-ready",
    };
  }

  const second = attemptOnce(to, 2);
  if (second.ok) return second;

  if (second.kind !== "retryable") {
    return {
      ok: false,
      error: second.error,
      to,
      ...lastDispatchProvenance(second, first),
      kind: second.kind,
    };
  }

  return {
    ok: false,
    error: `dispatch not accepted after 2 attempts: ${second.error}`,
    to,
    ...lastDispatchProvenance(second, first),
    kind: "exhausted",
  };
}

function lastDispatchProvenance(
  primary: DispatchAttemptFailure,
  fallback?: DispatchAttemptFailure,
): LastDispatchProvenance {
  const source = primary.taskId ? primary : fallback?.taskId ? fallback : null;
  if (!source?.taskId) return {};
  return {
    lastTaskId: source.taskId,
    lastDispatchId: source.dispatchId ?? null,
    lastAttempt: source.attempt,
  };
}

function terminalCursor(orcaCli: string, handle: string): string | null {
  const read = orcaJson(orcaCli, ["terminal", "read", "--terminal", handle]);
  if (!read.ok || !read.data) return null;
  const result = unwrapResult<{
    terminal?: { nextCursor?: string | number | null; latestCursor?: string | number | null };
  }>(read.data);
  const cursor = result.terminal?.nextCursor ?? result.terminal?.latestCursor;
  return cursor == null ? null : String(cursor);
}

function extractWait(data: unknown): {
  satisfied?: boolean;
  blockedReason?: string | null;
} {
  if (!data) return {};
  const result = unwrapResult<{
    wait?: {
      satisfied?: boolean;
      blockedReason?: string | null;
      status?: string;
    };
  }>(data);
  const w = result.wait;
  if (!w) return {};
  return {
    satisfied: w.satisfied,
    blockedReason: w.blockedReason ?? null,
  };
}

function sleepMs(ms: number): void {
  if (ms <= 0) return;
  execFile("sleep", [String(Math.max(0.001, ms / 1000))], {
    timeoutMs: ms + 2_000,
  });
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
    taskId?: unknown;
    task?: { id?: unknown };
    id?: unknown;
  }>(r.data);
  const taskId = asNonEmptyString(
    result.taskId ?? result.task?.id ?? result.id,
  );
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
    dispatchId?: unknown;
    dispatch?: { id?: unknown };
    id?: unknown;
  }>(r.data);
  const dispatchId = asNonEmptyString(
    result.dispatchId ?? result.dispatch?.id ?? result.id,
  );
  if (!dispatchId) {
    return {
      ok: false,
      error: `dispatch missing dispatchId: ${r.raw.slice(0, 800)}`,
    };
  }
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
      const type = (
        asNonEmptyString(msg.type) ??
        asNonEmptyString(msg.messageType) ??
        ""
      ).toLowerCase();
      const payload = parseMessagePayload(msg.payload);
      const messageTaskId = asNonEmptyString(msg.taskId);
      const payloadTaskId = asNonEmptyString(payload.taskId);
      const messageDispatchId = asNonEmptyString(msg.dispatchId);
      const payloadDispatchId = asNonEmptyString(payload.dispatchId);
      if (
        (messageTaskId &&
          payloadTaskId &&
          messageTaskId !== payloadTaskId) ||
        (messageDispatchId &&
          payloadDispatchId &&
          messageDispatchId !== payloadDispatchId)
      ) {
        continue;
      }
      const taskId = messageTaskId ?? payloadTaskId;
      const dispatchId = messageDispatchId ?? payloadDispatchId;

      const taskMatches = taskId === input.taskId;
      const dispatchMatches =
        input.dispatchId === null || dispatchId === input.dispatchId;

      if (type === "escalation" && taskMatches) {
        return {
          ok: false,
          error: "worker sent escalation",
          escalated: true,
          message: msg,
        };
      }
      if (type === "decision_gate" && taskMatches) {
        const gateId = asNonEmptyString(msg.id);
        if (!gateId) {
          return {
            ok: false,
            error: `decision_gate missing message id for task ${input.taskId}`,
            message: msg,
          };
        }
        const reply = orcaJson(orcaCli, [
          "orchestration",
          "reply",
          "--id",
          gateId,
          "--body",
          DECISION_GATE_REPLY,
          "--from",
          input.controllerHandle,
        ]);
        if (!reply.ok) {
          return {
            ok: false,
            error: `decision_gate reply failed for task ${input.taskId} (message ${gateId}): ${reply.error ?? "unknown Orca error"}`,
            message: msg,
          };
        }
        input.onTick?.(
          `replied to decision_gate ${gateId} for task ${input.taskId}; continuing to wait`,
        );
        continue;
      }
      if (type === "worker_done" && taskMatches && dispatchMatches) {
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

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseMessagePayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object"
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

export function worktreePs(orcaCli: string): unknown {
  const r = orcaJson(orcaCli, ["worktree", "ps"]);
  return r.data ?? { error: r.error };
}

export function taskList(orcaCli: string): unknown {
  const r = orcaJson(orcaCli, ["orchestration", "task-list"]);
  return r.data ?? { error: r.error };
}

export function orchestrationTaskStatus(
  orcaCli: string,
  taskId: string,
): string | null {
  const r = orcaJson(orcaCli, ["orchestration", "task-list"]);
  if (!r.ok || !r.data) return null;
  const result = unwrapResult<{
    tasks?: Array<{ id?: unknown; status?: unknown }>;
  }>(r.data);
  return asNonEmptyString(
    result.tasks?.find((task) => task.id === taskId)?.status,
  );
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
