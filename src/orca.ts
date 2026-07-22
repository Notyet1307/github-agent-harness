import { accessSync, constants } from "node:fs";
import { execFile, which } from "./exec.js";
import type { HarnessConfig } from "./types.js";

export type OrcaJsonResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
  raw: string;
  code: number | null;
};

export function resolveOrcaCli(config: HarnessConfig): string | null {
  const preferred = config.orca.cliPath;
  if (preferred !== "orca" && preferred.includes("/")) {
    if (isExecutable(preferred)) return preferred;
  }
  const fromPath = which(preferred);
  if (fromPath) return fromPath;
  if (isExecutable(config.orca.cliPathFallback)) {
    return config.orca.cliPathFallback;
  }
  return null;
}

export function requireOrcaCli(config: HarnessConfig): string {
  const cli = resolveOrcaCli(config);
  if (!cli) throw new Error("orca CLI not found");
  return cli;
}

export function orcaJson(
  orcaCli: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): OrcaJsonResult {
  const finalArgs = args.includes("--json") ? args : [...args, "--json"];
  const result = execFile(orcaCli, finalArgs, {
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  const raw = result.stdout || result.stderr;

  // Prefer last non-empty JSON object line (check --wait may be single JSON).
  const parsed = tryParseJson(result.stdout) ?? tryParseJson(result.stderr);
  if (parsed) {
    const envelope = parsed as { ok?: boolean; error?: { message?: string } };
    const ok =
      result.ok && envelope.ok !== false && !envelope.error;
    return {
      ok,
      data: parsed,
      error: ok
        ? undefined
        : envelope.error?.message || result.error || result.stderr || "orca failed",
      raw,
      code: result.code,
    };
  }

  return {
    ok: false,
    error: result.error || result.stderr || result.stdout || "orca failed",
    raw,
    code: result.code,
  };
}

export function orcaStatus(orcaCli: string): {
  ok: boolean;
  appRunning: boolean;
  runtimeReady: boolean;
  raw?: unknown;
  error?: string;
} {
  const parsed = orcaJson(orcaCli, ["status"]);
  if (!parsed.ok || !parsed.data) {
    return {
      ok: false,
      appRunning: false,
      runtimeReady: false,
      error: parsed.error,
    };
  }
  const data = parsed.data as {
    ok?: boolean;
    result?: {
      app?: { running?: boolean };
      runtime?: { state?: string; reachable?: boolean };
    };
  };
  const appRunning = Boolean(data.result?.app?.running);
  const runtimeReady =
    data.result?.runtime?.state === "ready" &&
    Boolean(data.result?.runtime?.reachable);
  return {
    ok: Boolean(data.ok) && appRunning && runtimeReady,
    appRunning,
    runtimeReady,
    raw: data,
  };
}

export function unwrapResult<T = Record<string, unknown>>(
  data: unknown,
): T {
  const env = data as { result?: T };
  if (env && typeof env === "object" && "result" in env && env.result) {
    return env.result;
  }
  return data as T;
}

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // try last line
    const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.startsWith("{")) continue;
      try {
        return JSON.parse(line);
      } catch {
        // continue
      }
    }
    return null;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
