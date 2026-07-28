import { listReadyIssues, viewIssue } from "./github.js";
import type {
  HarnessConfig,
  IssueCandidate,
  PickResult,
  PickSkip,
  RepoConfig,
  RuntimeHarnessConfig,
} from "./types.js";
import { hasOpenBlockers } from "./types.js";

/**
 * Dry-run / real pick logic without writing ledger.
 * Ledger membership is injected so M1 stays pure.
 */
export function pickForRepo(
  config: HarnessConfig,
  repo: RepoConfig,
  options: {
    ledgerIssueNumbers?: Set<number>;
    hasActiveJob?: boolean;
  } = {},
): PickResult {
  const ledger = options.ledgerIssueNumbers ?? new Set<number>();
  const skipped: PickSkip[] = [];
  const listed = listReadyIssues(repo, config.issueLabel);

  if (!listed.ok) {
    return {
      repo,
      selected: null,
      skipped: [
        {
          number: 0,
          title: "(list failed)",
          reason: "other",
          detail: listed.error,
        },
      ],
      eligible: [],
    };
  }

  const issues = listed.issues;
  const readyByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const childOwners = indexChildOwners(issues);
  const eligible: IssueCandidate[] = [];

  for (const issue of issues) {
    if (childOwners.has(issue.number)) continue;

    if (issue.parent && !readyByNumber.has(issue.parent.number)) {
      skipped.push({
        number: issue.number,
        title: issue.title,
        reason: "parented-child",
        detail: `parent Map #${issue.parent.number} is not in the ready snapshot`,
      });
      continue;
    }

    if (subIssues(issue).length > 0) {
      const result = mapFrontier(issue, readyByNumber, childOwners, ledger, skipped);
      if (result.unsupported) {
        skipped.push({
          number: issue.number,
          title: issue.title,
          reason: "unsupported-topology",
          detail: result.detail,
        });
      } else {
        skipped.push({
          number: issue.number,
          title: issue.title,
          reason: "map-container",
          detail: result.frontier
            ? `frontier #${result.frontier.number}`
            : result.detail,
        });
      }
      if (result.frontier) eligible.push(result.frontier);
      continue;
    }

    if (skipStandalone(issue, ledger, skipped)) continue;
    eligible.push(issue);
  }

  if (options.hasActiveJob) {
    return {
      repo,
      selected: null,
      skipped: [
        ...skipped,
        {
          number: 0,
          title: "(global slot)",
          reason: "other",
          detail: "active non-terminal job exists; V1 single-task gate",
        },
      ],
      eligible,
    };
  }

  if (eligible.length === 0) {
    return { repo, selected: null, skipped, eligible };
  }

  // Defensive re-fetch of the first candidate. A changed winner is retried on
  // the next poll rather than falling through to a later candidate.
  const first = eligible[0]!;
  const fresh = viewIssue(repo, first.number);
  if (!fresh.ok || !fresh.issue) {
    skipped.push({
      number: first.number,
      title: first.title,
      reason: "other",
      detail: fresh.error ?? "re-fetch failed",
    });
    return { repo, selected: null, skipped, eligible: eligible.slice(1) };
  }

  const issue = fresh.issue;
  const commonFailure = freshCandidateFailure(issue, config.issueLabel);
  if (commonFailure) {
    skipped.push(commonFailure);
    return { repo, selected: null, skipped, eligible: eligible.slice(1) };
  }

  if (first.mapNumber != null) {
    if ((issue.assignees ?? []).length > 0) {
      skipped.push({
        number: issue.number,
        title: issue.title,
        reason: "assigned",
        detail: "became assigned between list and claim",
      });
      return { repo, selected: null, skipped, eligible: eligible.slice(1) };
    }
    if (subIssues(issue).length > 0) {
      skipped.push({
        number: issue.number,
        title: issue.title,
        reason: "unsupported-topology",
        detail: "frontier child became a nested Map between list and claim",
      });
      return { repo, selected: null, skipped, eligible: eligible.slice(1) };
    }
    if (issue.parent && issue.parent.number !== first.mapNumber) {
      skipped.push({
        number: issue.number,
        title: issue.title,
        reason: "unsupported-topology",
        detail: `parent changed from Map #${first.mapNumber} to #${issue.parent.number}`,
      });
      return { repo, selected: null, skipped, eligible: eligible.slice(1) };
    }

    const freshMap = viewIssue(repo, first.mapNumber);
    const map = freshMap.issue;
    if (!freshMap.ok || !map) {
      skipped.push({
        number: issue.number,
        title: issue.title,
        reason: "other",
        detail: freshMap.error ?? `failed to re-fetch Map #${first.mapNumber}`,
      });
      return { repo, selected: null, skipped, eligible: eligible.slice(1) };
    }
    if (
      map.state !== "OPEN" ||
      !map.labels.includes(config.issueLabel) ||
      !topologyComplete(map) ||
      !subIssues(map).some((child) => child.number === issue.number)
    ) {
      skipped.push({
        number: issue.number,
        title: issue.title,
        reason: "unsupported-topology",
        detail: `Map #${first.mapNumber} changed between list and claim`,
      });
      return { repo, selected: null, skipped, eligible: eligible.slice(1) };
    }
  } else if (subIssues(issue).length > 0 || issue.parent) {
    skipped.push({
      number: issue.number,
      title: issue.title,
      reason: "unsupported-topology",
      detail: "standalone issue became part of a Map between list and claim",
    });
    return { repo, selected: null, skipped, eligible: eligible.slice(1) };
  }

  return {
    repo,
    selected: { ...issue, mapNumber: first.mapNumber },
    skipped,
    eligible,
  };
}

export function pickAll(
  config: RuntimeHarnessConfig,
  options: {
    ledgerByRepo?: Map<string, Set<number>>;
    hasActiveJob?: boolean;
  } = {},
): PickResult[] {
  return config.repositories.map((repo) =>
    pickForRepo(config, repo, {
      ledgerIssueNumbers: options.ledgerByRepo?.get(repo.github),
      hasActiveJob: options.hasActiveJob,
    }),
  );
}

function indexChildOwners(issues: IssueCandidate[]): Map<number, number[]> {
  const owners = new Map<number, number[]>();
  for (const issue of issues) {
    for (const child of subIssues(issue)) {
      const current = owners.get(child.number) ?? [];
      current.push(issue.number);
      owners.set(child.number, current);
    }
  }
  return owners;
}

function mapFrontier(
  map: IssueCandidate,
  readyByNumber: Map<number, IssueCandidate>,
  childOwners: Map<number, number[]>,
  ledger: Set<number>,
  skipped: PickSkip[],
): { frontier: IssueCandidate | null; unsupported: boolean; detail: string } {
  if (!topologyComplete(map)) {
    return {
      frontier: null,
      unsupported: true,
      detail: "GitHub returned an incomplete sub-issue list",
    };
  }

  for (const child of subIssues(map)) {
    const owners = childOwners.get(child.number) ?? [];
    if (owners.length !== 1 || owners[0] !== map.number) {
      return {
        frontier: null,
        unsupported: true,
        detail: `child #${child.number} belongs to multiple or inconsistent Maps`,
      };
    }
  }

  let frontier: IssueCandidate | null = null;
  for (const reference of subIssues(map)) {
    if ((reference.state ?? "OPEN").toUpperCase() !== "OPEN") continue;

    const child = readyByNumber.get(reference.number);
    if (!child) {
      if (!frontier) {
        return {
          frontier: null,
          unsupported: false,
          detail: `open child #${reference.number} is not ready for the agent`,
        };
      }
      continue;
    }
    if (child.parent && child.parent.number !== map.number) {
      return {
        frontier: null,
        unsupported: true,
        detail: `child #${child.number} points to parent #${child.parent.number}`,
      };
    }
    if (subIssues(child).length > 0) {
      return {
        frontier: null,
        unsupported: true,
        detail: `nested Map #${child.number} is not supported`,
      };
    }
    if (ledger.has(child.number)) {
      skipped.push({
        number: child.number,
        title: child.title,
        reason: "already-in-ledger",
        detail: `child of Map #${map.number}`,
      });
      continue;
    }
    if (hasOpenBlockers(child.blockedBy)) {
      skipped.push(blockedSkip(child));
      continue;
    }
    if ((child.assignees ?? []).length > 0) {
      skipped.push({
        number: child.number,
        title: child.title,
        reason: "assigned",
        detail: `assigned to ${(child.assignees ?? []).join(", ")}`,
      });
      continue;
    }
    if (!frontier) {
      frontier = { ...child, mapNumber: map.number };
    } else {
      skipped.push({
        number: child.number,
        title: child.title,
        reason: "parented-child",
        detail: `after frontier #${frontier.number} in Map #${map.number}`,
      });
    }
  }

  return {
    frontier,
    unsupported: false,
    detail: "no executable frontier",
  };
}

function skipStandalone(
  issue: IssueCandidate,
  ledger: Set<number>,
  skipped: PickSkip[],
): boolean {
  if (ledger.has(issue.number)) {
    skipped.push({
      number: issue.number,
      title: issue.title,
      reason: "already-in-ledger",
    });
    return true;
  }
  if (hasOpenBlockers(issue.blockedBy)) {
    skipped.push(blockedSkip(issue));
    return true;
  }
  return false;
}

function blockedSkip(issue: IssueCandidate): PickSkip {
  const blockers = issue.blockedBy
    .filter((blocker) => (blocker.state ?? "OPEN").toUpperCase() === "OPEN")
    .map((blocker) => `#${blocker.number}`)
    .join(", ");
  return {
    number: issue.number,
    title: issue.title,
    reason: "blocked",
    detail: `blocked by ${blockers}`,
  };
}

function freshCandidateFailure(
  issue: IssueCandidate & { state: string },
  issueLabel: string,
): PickSkip | null {
  if (issue.state !== "OPEN") {
    return {
      number: issue.number,
      title: issue.title,
      reason: "not-open",
      detail: `state=${issue.state}`,
    };
  }
  if (!issue.labels.includes(issueLabel)) {
    return {
      number: issue.number,
      title: issue.title,
      reason: "no-ready-label",
    };
  }
  if (hasOpenBlockers(issue.blockedBy)) {
    return {
      number: issue.number,
      title: issue.title,
      reason: "blocked",
      detail: "became blocked between list and claim",
    };
  }
  return null;
}

function subIssues(issue: IssueCandidate) {
  return issue.subIssues ?? [];
}

function topologyComplete(issue: IssueCandidate): boolean {
  return issue.subIssuesTotal == null || issue.subIssuesTotal === subIssues(issue).length;
}
