/**
 * Pure helpers: detect whether an agent TUI actually accepted a dispatch.
 * Used after orchestration dispatch --inject to catch "silent idle" failures.
 */

export type TerminalProbeSnapshot = {
  title: string;
  preview: string;
  tailText: string;
  /** True when tailText was read from the cursor captured before dispatch. */
  freshOutput: boolean;
  /** At least one Orca terminal probe returned usable state. */
  observed: boolean;
  /** null = unknown */
  idle: boolean | null;
  blockedReason: string | null;
};

export type DispatchAcceptVerdict =
  | { accepted: true; reason: string }
  | {
      accepted: false;
      reason: string;
      interactive?: boolean;
      retryable?: boolean;
      unknown?: boolean;
    };

export type WorkerLivenessVerdict =
  | { healthy: true }
  | { healthy: false; reason: string };

/**
 * Detect terminal states which cannot produce worker_done without a new
 * provider request. Keep this deliberately narrow: Pi owns transient retries;
 * Harness intervenes only after Pi reports that those retries are exhausted.
 */
export function verdictWorkerLiveness(
  snap: TerminalProbeSnapshot,
): WorkerLivenessVerdict {
  const blob = [snap.title, snap.preview, snap.tailText].join("\n").toLowerCase();
  const exhaustedResponsesStream =
    blob.includes("retry failed after 3 attempts") &&
    blob.includes("responses stream ended before a terminal response event");
  if (exhaustedResponsesStream) {
    return {
      healthy: false,
      reason: "provider Responses stream failed after Pi exhausted its retries",
    };
  }
  return { healthy: true };
}

/**
 * Heuristics for "agent started the dispatched task".
 * Prefer strong signals (task id / worker preamble); fall back to non-idle TUI.
 */
export function verdictDispatchAccepted(
  snap: TerminalProbeSnapshot,
  taskId: string,
): DispatchAcceptVerdict {
  const blob = [snap.title, snap.preview, snap.tailText]
    .join("\n")
    .toLowerCase();
  const freshBlob = snap.freshOutput ? snap.tailText.toLowerCase() : "";
  const freshLines = freshBlob.split("\n").map((line) => line.trim());
  const reason = snap.blockedReason?.toLowerCase() ?? "";

  if (!snap.observed) {
    return {
      accepted: false,
      reason: "terminal acceptance probe unavailable",
      unknown: true,
    };
  }

  if (
    reason.includes("interactive") ||
    reason.includes("codex-interactive-prompt") ||
    freshLines.some((line) => /^hooks need review\b/.test(line))
  ) {
    return {
      accepted: false,
      reason: `agent blocked on interactive prompt (${snap.blockedReason ?? "hooks/ui"})`,
      interactive: true,
    };
  }

  const providerStartupFailed = freshLines.some((text) => {
    return (
      /^(?:error:\s*)?codex version (?:is )?too low/.test(text) ||
      /^(?:\[?(?:error|fatal)\]?:?).{0,80}\b(?:provider|model|gateway)\b/.test(
        text,
      ) ||
      /^(?:provider|model|gateway)\b.{0,80}\b(?:error|failed|unavailable|not found|unsupported)\b/.test(
        text,
      )
    );
  });
  if (providerStartupFailed) {
    return {
      accepted: false,
      reason: "agent provider/model startup failed",
      retryable: true,
    };
  }

  const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    taskId &&
    new RegExp(`(^|[^a-z0-9_-])${escapedTaskId}($|[^a-z0-9_-])`, "i").test(
      blob,
    )
  ) {
    return { accepted: true, reason: `task id ${taskId} visible in terminal` };
  }
  if (freshBlob.includes("your task id is")) {
    return { accepted: true, reason: "dispatch preamble visible (task id line)" };
  }
  if (
    freshBlob.includes("dispatched worker") ||
    freshBlob.includes("you are a dispatched worker")
  ) {
    return { accepted: true, reason: "dispatch worker preamble visible" };
  }
  // Orca / agent busy indicators
  if (
    /\bworking\b/.test(freshBlob) ||
    freshBlob.includes("worked for")
  ) {
    return { accepted: true, reason: "terminal shows working indicator" };
  }

  // Non-idle TUI without interactive block → likely running
  if (snap.idle === false && !reason.includes("interactive")) {
    return { accepted: true, reason: "tui not idle after dispatch" };
  }

  if (snap.idle === true) {
    return {
      accepted: false,
      reason: "tui still idle after dispatch (inject likely dropped)",
    };
  }

  return {
    accepted: false,
    reason: "no dispatch-acceptance signal observed",
  };
}
