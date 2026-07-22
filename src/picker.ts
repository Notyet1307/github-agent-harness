import { listReadyIssues, viewIssue } from "./github.js";
import type {
  HarnessConfig,
  IssueCandidate,
  PickResult,
  PickSkip,
  RepoConfig,
} from "./types.js";

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

  const eligible: IssueCandidate[] = [];

  for (const issue of listed.issues) {
    if (ledger.has(issue.number)) {
      skipped.push({
        number: issue.number,
        title: issue.title,
        reason: "already-in-ledger",
      });
      continue;
    }
    if (issue.blockedBy.length > 0) {
      const blockers = issue.blockedBy.map((b) => `#${b.number}`).join(", ");
      skipped.push({
        number: issue.number,
        title: issue.title,
        reason: "blocked",
        detail: `blocked by ${blockers}`,
      });
      continue;
    }
    eligible.push(issue);
  }

  // Also surface open issues without the label for explainability (best-effort).
  // Not required for selection.

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

  // Defensive re-fetch of the first candidate.
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
  if (issue.state !== "OPEN") {
    skipped.push({
      number: issue.number,
      title: issue.title,
      reason: "not-open",
      detail: `state=${issue.state}`,
    });
    return { repo, selected: null, skipped, eligible: eligible.slice(1) };
  }
  if (!issue.labels.includes(config.issueLabel)) {
    skipped.push({
      number: issue.number,
      title: issue.title,
      reason: "no-ready-label",
    });
    return { repo, selected: null, skipped, eligible: eligible.slice(1) };
  }
  if (issue.blockedBy.length > 0) {
    skipped.push({
      number: issue.number,
      title: issue.title,
      reason: "blocked",
      detail: "became blocked between list and claim",
    });
    return { repo, selected: null, skipped, eligible: eligible.slice(1) };
  }

  return {
    repo,
    selected: issue,
    skipped,
    eligible,
  };
}

export function pickAll(
  config: HarnessConfig,
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
