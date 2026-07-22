import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IssueCandidate, Job, JobState } from "./types.js";
import { TERMINAL_JOB_STATES } from "./types.js";

export class Ledger {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        issue_url TEXT NOT NULL,
        issue_updated_at TEXT NOT NULL,
        issue_snapshot_json TEXT NOT NULL,
        state TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        base_sha TEXT,
        branch TEXT,
        worktree_id TEXT,
        worktree_path TEXT,
        implementer_profile_id TEXT,
        implementer_terminal_handle TEXT,
        implementer_task_id TEXT,
        implementer_dispatch_id TEXT,
        controller_terminal_handle TEXT,
        audit_round INTEGER NOT NULL DEFAULT 0,
        audit_result_json TEXT,
        pr_number INTEGER,
        pr_url TEXT,
        merged_at TEXT,
        last_error TEXT,
        head_sha TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo, issue_number)
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
    `);
  }

  hasActiveJob(): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM jobs WHERE state NOT IN ('merged', 'cancelled') LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    return Boolean(row);
  }

  getActiveJob(): Job | null {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE state NOT IN ('merged', 'cancelled')
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as Job | undefined;
    return row ?? null;
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
      | Job
      | undefined;
    return row ?? null;
  }

  listJobs(limit = 20): Job[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs ORDER BY datetime(updated_at) DESC LIMIT ?`,
      )
      .all(limit) as Job[];
  }

  ledgerIssueNumbers(repo: string): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT issue_number FROM jobs
         WHERE repo = ? AND state NOT IN ('merged', 'cancelled')`,
      )
      .all(repo) as Array<{ issue_number: number }>;
    return new Set(rows.map((r) => r.issue_number));
  }

  /**
   * Atomic claim: only if no active job and (repo, issue) not active.
   * UNIQUE(repo, issue_number) blocks re-claim of same issue ever;
   * for M2 we allow re-claim only after merged/cancelled by deleting? No —
   * UNIQUE is permanent. For reopen later we'll migrate. V1: if row exists
   * in terminal state, we update it to a new claim (reuse row).
   */
  tryClaim(input: {
    id: string;
    repo: string;
    issue: IssueCandidate;
    baseRef: string;
    implementerProfileId: string;
  }): { ok: true; job: Job } | { ok: false; error: string } {
    const now = isoNow();
    const snapshot = JSON.stringify(input.issue);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db
        .prepare(
          `SELECT id, repo, issue_number, state FROM jobs
           WHERE state NOT IN ('merged', 'cancelled') LIMIT 1`,
        )
        .get() as
        | { id: string; repo: string; issue_number: number; state: string }
        | undefined;
      if (active) {
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          error: `active job ${active.id} (${active.repo}#${active.issue_number} ${active.state})`,
        };
      }

      const existing = this.db
        .prepare(
          `SELECT id, state FROM jobs WHERE repo = ? AND issue_number = ?`,
        )
        .get(input.repo, input.issue.number) as
        | { id: string; state: JobState }
        | undefined;

      if (existing && !TERMINAL_JOB_STATES.has(existing.state)) {
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          error: `issue already claimed as ${existing.id} (${existing.state})`,
        };
      }

      if (existing && TERMINAL_JOB_STATES.has(existing.state)) {
        // Re-open a finished issue as a new attempt (same row, new id fields).
        this.db
          .prepare(
            `UPDATE jobs SET
              id = ?,
              issue_url = ?,
              issue_updated_at = ?,
              issue_snapshot_json = ?,
              state = 'claimed',
              base_ref = ?,
              base_sha = NULL,
              branch = NULL,
              worktree_id = NULL,
              worktree_path = NULL,
              implementer_profile_id = ?,
              implementer_terminal_handle = NULL,
              implementer_task_id = NULL,
              implementer_dispatch_id = NULL,
              controller_terminal_handle = NULL,
              audit_round = 0,
              audit_result_json = NULL,
              pr_number = NULL,
              pr_url = NULL,
              merged_at = NULL,
              last_error = NULL,
              head_sha = NULL,
              created_at = ?,
              updated_at = ?
            WHERE repo = ? AND issue_number = ?`,
          )
          .run(
            input.id,
            input.issue.url,
            input.issue.updatedAt,
            snapshot,
            input.baseRef,
            input.implementerProfileId,
            now,
            now,
            input.repo,
            input.issue.number,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO jobs (
              id, repo, issue_number, issue_url, issue_updated_at, issue_snapshot_json,
              state, base_ref, implementer_profile_id, audit_round,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?, 0, ?, ?)`,
          )
          .run(
            input.id,
            input.repo,
            input.issue.number,
            input.issue.url,
            input.issue.updatedAt,
            snapshot,
            input.baseRef,
            input.implementerProfileId,
            now,
            now,
          );
      }

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      return { ok: false, error: (err as Error).message };
    }

    const job = this.getJob(input.id);
    if (!job) return { ok: false, error: "claim succeeded but job missing" };
    return { ok: true, job };
  }

  updateJob(
    id: string,
    patch: Partial<
      Pick<
        Job,
        | "state"
        | "base_sha"
        | "branch"
        | "worktree_id"
        | "worktree_path"
        | "implementer_profile_id"
        | "implementer_terminal_handle"
        | "implementer_task_id"
        | "implementer_dispatch_id"
        | "controller_terminal_handle"
        | "audit_round"
        | "audit_result_json"
        | "pr_number"
        | "pr_url"
        | "merged_at"
        | "last_error"
        | "head_sha"
      >
    >,
  ): Job {
    const allowed = Object.keys(patch) as Array<keyof typeof patch>;
    if (allowed.length === 0) {
      const job = this.getJob(id);
      if (!job) throw new Error(`job not found: ${id}`);
      return job;
    }
    const sets = allowed.map((k) => `${k} = ?`).join(", ");
    const values = allowed.map((k) => patch[k] ?? null);
    this.db
      .prepare(
        `UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`,
      )
      .run(...values, isoNow(), id);
    const job = this.getJob(id);
    if (!job) throw new Error(`job not found after update: ${id}`);
    return job;
  }
}

function isoNow(): string {
  return new Date().toISOString();
}
