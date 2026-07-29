import { spawnSync } from "node:child_process";

export type ExecResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export function execFile(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    input?: string;
  } = {},
): ExecResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    env: { ...process.env, ...options.env },
    input: options.input,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    return {
      ok: false,
      code: result.status,
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
      error: result.error.message,
    };
  }

  const code = result.status;
  return {
    ok: code === 0,
    code,
    stdout: (result.stdout ?? "").toString(),
    stderr: (result.stderr ?? "").toString(),
  };
}

export function which(command: string): string | null {
  const result = execFile("bash", ["-lc", `command -v ${shellQuote(command)}`]);
  if (!result.ok) return null;
  const path = result.stdout.trim();
  return path || null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
