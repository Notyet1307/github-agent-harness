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

export function refreshBaseRef(
  cwd: string,
  baseRef: string,
):
  | { ok: true; sha: string }
  | { ok: false; error: string } {
  const separator = baseRef.indexOf("/");
  if (separator <= 0) {
    return {
      ok: false,
      error: `baseRef must be a remote-tracking ref: ${baseRef}`,
    };
  }
  const remote = baseRef.slice(0, separator);
  const branch = baseRef.slice(separator + 1);
  const remotes = git(cwd, ["remote"]);
  if (
    !remotes.ok ||
    !remotes.stdout.split("\n").includes(remote)
  ) {
    return { ok: false, error: `baseRef remote not found: ${remote}` };
  }

  const fetched = execFile("git", [
    "-C",
    cwd,
    "fetch",
    "--prune",
    remote,
    `+refs/heads/${branch}:refs/remotes/${baseRef}`,
  ]);
  if (!fetched.ok) {
    return {
      ok: false,
      error: `failed to refresh ${baseRef}: ${
        fetched.stderr.trim() || fetched.error || `exit ${fetched.code}`
      }`,
    };
  }

  const sha = revParse(cwd, `refs/remotes/${baseRef}^{commit}`);
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    return {
      ok: false,
      error: `cannot resolve refreshed baseRef ${baseRef}`,
    };
  }
  return { ok: true, sha };
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

export function checkAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
):
  | { ok: true; isAncestor: boolean }
  | { ok: false; error: string } {
  const result = execFile("git", [
    "-C",
    cwd,
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  if (result.code === 0) return { ok: true, isAncestor: true };
  if (result.code === 1) return { ok: true, isAncestor: false };
  return {
    ok: false,
    error:
      result.stderr.trim() ||
      result.error ||
      `git merge-base exited ${result.code ?? "without a status"}`,
  };
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
