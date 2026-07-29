import { defaultLedgerPath, defaultLockPath } from "./config.js";
import { trackedDirty } from "./audit-gate.js";
import { execFile } from "./exec.js";
import {
  findPrByHead,
  issueStillClaimable,
  viewPullRequest,
} from "./github.js";
import { checkAncestor, revParse, statusPorcelain } from "./git.js";
import { Ledger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import { orcaStatus, requireOrcaCli } from "./orca.js";
import { loadRuntimeConfig, validateProjectRuntime } from "./project.js";
import { recordPushFailure } from "./push-failure.js";
import { setWorktreeProgress } from "./orca-runtime.js";
import type { Job, RepoConfig, RuntimeHarnessConfig } from "./types.js";

export type PublishResult = {
  ok: boolean;
  jobId?: string;
  message: string;
  details?: Record<string, unknown>;
};

/**
 * M4: after audit_passed, push branch and ensure a PR exists.
 * Does not merge. Does not claim next issue.
 */
export function publishOnce(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
}): PublishResult {
  const config = loadRuntimeConfig(options.configPath);
  const lock = acquireLock(options.lockPath ?? defaultLockPath());
  if (!lock.ok) return { ok: false, message: lock.error ?? "lock failed" };
  const ledger = new Ledger(options.ledgerPath ?? defaultLedgerPath());
  try {
    return publishOnceLocked(config, ledger);
  } finally {
    ledger.close();
    lock.release();
  }
}

function publishOnceLocked(
  config: RuntimeHarnessConfig,
  ledger: Ledger,
): PublishResult {
  const log = (m: string) => process.stdout.write(`[publish-once] ${m}\n`);

  let job = ledger.getActiveJob();
  if (!job) return { ok: false, message: "no active job" };

  if (job.state === "awaiting_merge" && job.pr_url) {
    return {
      ok: true,
      jobId: job.id,
      message: "already awaiting_merge",
      details: {
        pr_url: job.pr_url,
        pr_number: job.pr_number,
      },
    };
  }

  if (job.state === "merged") {
    return { ok: true, jobId: job.id, message: "already merged" };
  }

  if (job.state !== "audit_passed" && job.state !== "publishing") {
    return {
      ok: false,
      jobId: job.id,
      message: `job state ${job.state} cannot publish (need audit_passed)`,
    };
  }

  const project = ledger.resolveJobProject(job.id, config.repositories);
  if (!project.ok) return block(ledger, job, project.error);
  job = project.job;
  const repo = project.project;
  if (
    !job.worktree_path ||
    !job.worktree_id ||
    !job.branch ||
    !job.base_sha ||
    !job.head_sha
  ) {
    return {
      ok: false,
      jobId: job.id,
      message: "job missing worktree/branch/base_sha/head_sha",
    };
  }
  const worktreePath = job.worktree_path;
  const worktreeId = job.worktree_id;
  const branch = job.branch;
  const baseSha = job.base_sha;
  let headSha = job.head_sha;

  // 1) Integrity checks
  const head = revParse(worktreePath, "HEAD");
  if (!head) {
    return block(ledger, job, "cannot read HEAD before publish");
  }
  if (head !== headSha && !shaPrefixMatch(head, headSha)) {
    return block(
      ledger,
      job,
      `HEAD ${head} != audited head ${headSha}; re-run audit-once`,
    );
  }
  const ancestry = checkAncestor(worktreePath, baseSha, head);
  if (!ancestry.ok || !ancestry.isAncestor) {
    return block(
      ledger,
      job,
      ancestry.ok
        ? "publish HEAD is not a descendant of base SHA"
        : `cannot verify publish base ancestry: ${ancestry.error}`,
    );
  }
  // refresh head if prefix match only
  if (head !== headSha) {
    headSha = head;
    job = ledger.updateJob(job.id, { head_sha: head });
  }

  const dirty = statusPorcelain(worktreePath);
  // allow untracked .pi/.harness; block tracked mods
  const tracked = trackedDirty(worktreePath);
  if (tracked) {
    return block(
      ledger,
      job,
      `tracked files dirty or unreadable before publish:\n${tracked}`,
    );
  }

  const orcaCli = requireOrcaCli(config);
  const st = orcaStatus(orcaCli);
  if (!st.ok) {
    return { ok: false, message: `orca not ready: ${st.error ?? "unknown"}` };
  }
  const runtime = validateProjectRuntime(repo, orcaCli);
  if (!runtime.ok) return block(ledger, job, runtime.error);

  job = ledger.updateJob(job.id, { state: "publishing" });
  setWorktreeProgress(
    orcaCli,
    worktreeId,
    "harness: publishing PR",
    "in-review",
  );

  const claimable = issueStillClaimable(
    repo,
    job.issue_number,
    config.issueLabel,
  );
  if (!claimable.ok) {
    return block(ledger, job, claimable.error ?? "issue no longer claimable");
  }

  // 2) ensure remote branch (push)
  log(`pushing ${branch} → origin`);
  const push = execFile(
    "git",
    ["-C", worktreePath, "push", "-u", "origin", `HEAD:refs/heads/${branch}`],
    { timeoutMs: 120_000 },
  );
  if (!push.ok) {
    const detail = [push.stderr, push.error, push.stdout]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join("\n") || "unknown git push failure";
    const failure = recordPushFailure(
      detail,
      job.last_error,
    );
    ledger.updateJob(job.id, {
      state: failure.retryable ? "audit_passed" : "blocked",
      last_error: failure.error,
    });
    return { ok: false, jobId: job.id, message: failure.error };
  }
  log("push ok");

  // 3) ensure PR
  const existing = findPrByHead(repo, branch);
  if (existing.ok && existing.pr) {
    job = ledger.updateJob(job.id, {
      state: "awaiting_merge",
      pr_number: existing.pr.number,
      pr_url: existing.pr.url,
      last_error: null,
    });
    setWorktreeProgress(
      orcaCli,
      worktreeId,
      `harness: awaiting_merge PR #${existing.pr.number}`,
      "in-review",
    );
    log(`reusing PR #${existing.pr.number} ${existing.pr.url}`);
    return {
      ok: true,
      jobId: job.id,
      message: "PR already exists; awaiting_merge",
      details: existing.pr,
    };
  }

  const title = prTitle(job);
  const body = prBody(job, repo, config);
  log(`creating PR base=${repo.defaultBranch} head=${branch}`);
  const created = execFile(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      repo.github,
      "--base",
      repo.defaultBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ],
    { timeoutMs: 120_000 },
  );
  if (!created.ok) {
    // race: PR may have been created
    const again = findPrByHead(repo, branch);
    if (again.ok && again.pr) {
      job = ledger.updateJob(job.id, {
        state: "awaiting_merge",
        pr_number: again.pr.number,
        pr_url: again.pr.url,
        last_error: null,
      });
      return {
        ok: true,
        jobId: job.id,
        message: "PR found after create race; awaiting_merge",
        details: again.pr,
      };
    }
    return block(
      ledger,
      job,
      `gh pr create failed: ${created.stderr || created.error || created.stdout}`,
    );
  }

  const prUrl = created.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  const viewed = prUrl
    ? viewPullRequest(repo, prUrl)
    : findPrByHead(repo, branch);

  const prNumber =
    viewed.ok && viewed.pr
      ? viewed.pr.number
      : Number(prUrl.match(/\/pull\/(\d+)/)?.[1] ?? 0) || null;
  const finalUrl =
    (viewed.ok && viewed.pr?.url) || prUrl || null;

  job = ledger.updateJob(job.id, {
    state: "awaiting_merge",
    pr_number: prNumber,
    pr_url: finalUrl,
    last_error: null,
  });
  setWorktreeProgress(
    orcaCli,
    worktreeId,
    `harness: awaiting_merge PR #${prNumber ?? "?"}`,
    "in-review",
  );

  return {
    ok: true,
    jobId: job.id,
    message: "PR created; awaiting_merge (no auto-merge)",
    details: {
      pr_number: prNumber,
      pr_url: finalUrl,
      branch,
      head_sha: headSha,
      dirty_untracked_only: dirty || "(clean)",
    },
  };
}

function block(
  ledger: Ledger,
  job: Job,
  error: string,
): PublishResult {
  ledger.updateJob(job.id, { state: "blocked", last_error: error });
  return { ok: false, jobId: job.id, message: error };
}

function prTitle(job: Job): string {
  try {
    const snap = JSON.parse(job.issue_snapshot_json) as { title?: string };
    const t = snap.title?.trim();
    if (t) return `Fix #${job.issue_number}: ${t}`;
  } catch {
    // ignore
  }
  return `Fix #${job.issue_number}`;
}

function prBody(
  job: Job,
  repo: RepoConfig,
  _config: RuntimeHarnessConfig,
): string {
  let auditSummary = "(no audit json stored)";
  let auditRound = job.audit_round;
  try {
    if (job.audit_result_json) {
      const a = JSON.parse(job.audit_result_json) as {
        status?: string;
        standards?: { documented_standard_violations?: unknown[] };
        spec?: {
          missing_or_partial?: unknown[];
          incorrect_implementation?: unknown[];
          scope_creep?: unknown[];
        };
        validation?: { commands?: Array<{ command: string; ok: boolean }> };
      };
      const std = a.standards?.documented_standard_violations?.length ?? 0;
      const spec =
        (a.spec?.missing_or_partial?.length ?? 0) +
        (a.spec?.incorrect_implementation?.length ?? 0) +
        (a.spec?.scope_creep?.length ?? 0);
      const val = (a.validation?.commands ?? [])
        .map((c) => `- \`${c.command}\`: ${c.ok ? "PASS" : "FAIL"}`)
        .join("\n");
      auditSummary = [
        `- Status: ${a.status ?? "?"}`,
        `- Standards hard violations: ${std}`,
        `- Spec findings: ${spec}`,
        `- Audit round: ${auditRound}`,
        val ? `\n### Commands\n${val}` : "",
      ].join("\n");
    }
  } catch {
    auditSummary = "(audit json parse failed)";
  }

  let issueTitle = "";
  try {
    issueTitle =
      (JSON.parse(job.issue_snapshot_json) as { title?: string }).title ?? "";
  } catch {
    // ignore
  }

  return `## Summary

Implements ${repo.github}#${job.issue_number}${issueTitle ? `: ${issueTitle}` : ""}.

Independent audit passed before this PR was opened by the harness controller.

## Changes

- Branch: \`${job.branch}\`
- Base: \`${job.base_sha?.slice(0, 7)}\`
- Head: \`${job.head_sha?.slice(0, 7)}\`

## Verification

See independent audit validation commands.

## Independent audit

${auditSummary}

Closes #${job.issue_number}
`;
}

function shaPrefixMatch(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
}
