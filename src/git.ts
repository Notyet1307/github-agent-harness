import { execFile } from "./exec.js";

export function git(cwd: string, args: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  const r = execFile("git", ["-C", cwd, ...args]);
  return { ok: r.ok, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

export function revParse(cwd: string, rev = "HEAD"): string | null {
  const r = git(cwd, ["rev-parse", rev]);
  return r.ok ? r.stdout : null;
}

export function currentBranch(cwd: string): string | null {
  const r = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return r.ok && r.stdout ? r.stdout : null;
}

export function ensureBranch(cwd: string, branch: string): {
  ok: boolean;
  branch: string;
  error?: string;
} {
  const existing = currentBranch(cwd);
  if (existing) return { ok: true, branch: existing };
  const create = git(cwd, ["checkout", "-b", branch]);
  if (!create.ok) {
    return { ok: false, branch, error: create.stderr || "checkout -b failed" };
  }
  return { ok: true, branch };
}

export function commitCountSince(cwd: string, baseSha: string): number {
  const r = git(cwd, ["rev-list", "--count", `${baseSha}..HEAD`]);
  if (!r.ok) return 0;
  return Number(r.stdout) || 0;
}

export function logOnelineSince(cwd: string, baseSha: string): string[] {
  const r = git(cwd, ["log", `${baseSha}..HEAD`, "--oneline"]);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split("\n").filter(Boolean);
}

export function statusPorcelain(cwd: string): string {
  const r = git(cwd, ["status", "--porcelain"]);
  return r.ok ? r.stdout : r.stderr;
}

export function isPushed(cwd: string, branch: string): boolean {
  const r = git(cwd, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  return r.ok;
}
