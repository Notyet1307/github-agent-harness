import { execFile } from "./exec.js";
import type { IssueCandidate, RepoConfig } from "./types.js";

type GhIssueJson = {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  state?: string;
  labels?: Array<string | { name: string }>;
  blockedBy?:
    | Array<{ number: number; title?: string }>
    | { nodes?: Array<{ number: number; title?: string }>; totalCount?: number };
};

export function ghAuthOk(): { ok: boolean; detail: string } {
  const result = execFile("gh", ["auth", "status"]);
  if (!result.ok) {
    return {
      ok: false,
      detail: result.stderr || result.error || "gh auth status failed",
    };
  }
  return { ok: true, detail: result.stdout.trim().split("\n")[0] ?? "ok" };
}

export function listReadyIssues(
  repo: RepoConfig,
  issueLabel: string,
): { ok: boolean; issues: IssueCandidate[]; error?: string } {
  // List all open ready-labeled issues, then filter blocked in code.
  // Keeps blocked items visible for dry-run skip explanations.
  const result = execFile("gh", [
    "issue",
    "list",
    "--repo",
    repo.github,
    "--state",
    "open",
    "--label",
    issueLabel,
    "--limit",
    "50",
    "--json",
    "number,title,url,updatedAt,labels,blockedBy,state",
  ]);

  if (!result.ok) {
    return {
      ok: false,
      issues: [],
      error: result.stderr || result.error || "gh issue list failed",
    };
  }

  let parsed: GhIssueJson[];
  try {
    parsed = JSON.parse(result.stdout) as GhIssueJson[];
  } catch (err) {
    return {
      ok: false,
      issues: [],
      error: `failed to parse gh issue list: ${(err as Error).message}`,
    };
  }

  const issues = parsed
    .map(normalizeIssue)
    .sort((a, b) => a.number - b.number);

  return { ok: true, issues };
}

export function viewIssue(
  repo: RepoConfig,
  number: number,
): { ok: boolean; issue?: IssueCandidate & { state: string }; error?: string } {
  const result = execFile("gh", [
    "issue",
    "view",
    String(number),
    "--repo",
    repo.github,
    "--json",
    "number,title,url,updatedAt,labels,blockedBy,state",
  ]);
  if (!result.ok) {
    return {
      ok: false,
      error: result.stderr || result.error || "gh issue view failed",
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as GhIssueJson;
    const issue = normalizeIssue(parsed);
    return {
      ok: true,
      issue: { ...issue, state: parsed.state ?? "UNKNOWN" },
    };
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse gh issue view: ${(err as Error).message}`,
    };
  }
}

function normalizeIssue(raw: GhIssueJson): IssueCandidate {
  const labels = (raw.labels ?? []).map((l) =>
    typeof l === "string" ? l : l.name,
  );
  const blockedBy = normalizeBlockedBy(raw.blockedBy);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    updatedAt: raw.updatedAt,
    labels,
    blockedBy,
  };
}

function normalizeBlockedBy(
  blockedBy: GhIssueJson["blockedBy"],
): Array<{ number: number; title?: string }> {
  if (!blockedBy) return [];
  if (Array.isArray(blockedBy)) return blockedBy;
  return blockedBy.nodes ?? [];
}
