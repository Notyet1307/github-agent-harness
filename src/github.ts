import { execFile } from "./exec.js";
import type { IssueCandidate, RepoConfig } from "./types.js";

export type PullRequestView = {
  number: number;
  url: string;
  title: string;
  state: string;
  mergedAt: string | null;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<{
    name?: string;
    context?: string;
    state?: string;
    conclusion?: string;
    status?: string;
  }>;
  headRefName?: string;
  baseRefName?: string;
};

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

/** Issue still open, has ready label, not blocked. */
export function issueStillClaimable(
  repo: RepoConfig,
  number: number,
  issueLabel: string,
): { ok: boolean; error?: string } {
  const viewed = viewIssue(repo, number);
  if (!viewed.ok || !viewed.issue) {
    return { ok: false, error: viewed.error ?? "issue view failed" };
  }
  const issue = viewed.issue;
  if (issue.state !== "OPEN") {
    return { ok: false, error: `issue state=${issue.state}` };
  }
  if (!issue.labels.includes(issueLabel)) {
    return { ok: false, error: `missing label ${issueLabel}` };
  }
  if (issue.blockedBy.length > 0) {
    return {
      ok: false,
      error: `blocked by ${issue.blockedBy.map((b) => `#${b.number}`).join(",")}`,
    };
  }
  return { ok: true };
}

export function findPrByHead(
  repo: RepoConfig,
  headBranch: string,
): { ok: boolean; pr?: PullRequestView; error?: string } {
  // head may be OWNER:branch for forks; same-repo uses branch name.
  const candidates = [headBranch, `${repo.github.split("/")[0]}:${headBranch}`];
  for (const head of candidates) {
    const result = execFile("gh", [
      "pr",
      "list",
      "--repo",
      repo.github,
      "--state",
      "open",
      "--head",
      head,
      "--json",
      "number,url,title,state,headRefName,baseRefName",
      "--limit",
      "5",
    ]);
    if (!result.ok) continue;
    try {
      const list = JSON.parse(result.stdout) as Array<{
        number: number;
        url: string;
        title: string;
        state: string;
        headRefName?: string;
        baseRefName?: string;
      }>;
      if (list.length > 0) {
        const p = list[0]!;
        return {
          ok: true,
          pr: {
            number: p.number,
            url: p.url,
            title: p.title,
            state: p.state,
            mergedAt: null,
            headRefName: p.headRefName,
            baseRefName: p.baseRefName,
          },
        };
      }
    } catch {
      // try next
    }
  }
  return { ok: true }; // none found
}

export function viewPullRequest(
  repo: RepoConfig,
  numberOrUrl: string | number,
): { ok: boolean; pr?: PullRequestView; error?: string } {
  const result = execFile("gh", [
    "pr",
    "view",
    String(numberOrUrl),
    "--repo",
    repo.github,
    "--json",
    "number,url,title,state,mergedAt,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,baseRefName",
  ]);
  if (!result.ok) {
    return {
      ok: false,
      error: result.stderr || result.error || "gh pr view failed",
    };
  }
  try {
    const p = JSON.parse(result.stdout) as PullRequestView;
    return { ok: true, pr: p };
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse gh pr view: ${(err as Error).message}`,
    };
  }
}
