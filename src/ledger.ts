import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createProjectSnapshot,
  parseProjectSnapshot,
  projectConfigFromSnapshot,
} from "./project.js";
import type { IssueCandidate, Job, JobState, RepoConfig } from "./types.js";
import { TERMINAL_JOB_STATES } from "./types.js";

const LEDGER_SCHEMA_VERSION = 1;

type JobPatch = Partial<
  Pick<
    Job,
    | "state"
    | "base_sha"
    | "project_key"
    | "project_revision"
    | "project_snapshot_json"
    | "branch"
    | "worktree_id"
    | "worktree_path"
    | "implementer_profile_id"
    | "implementer_terminal_handle"
    | "implementer_task_id"
    | "implementer_dispatch_id"
    | "auditor_profile_id"
    | "auditor_terminal_handle"
    | "auditor_task_id"
    | "auditor_dispatch_id"
    | "dispatch_attempt"
    | "dispatch_probe_pending"
    | "controller_terminal_handle"
    | "audit_round"
    | "audit_result_json"
    | "audit_head_sha"
    | "pr_number"
    | "pr_url"
    | "merged_at"
    | "last_error"
    | "head_sha"
  >
>;

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
    const version = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version.user_version > LEDGER_SCHEMA_VERSION) {
      throw new Error(
        `ledger schema version ${version.user_version} is newer than supported version ${LEDGER_SCHEMA_VERSION}`,
      );
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          issue_number INTEGER NOT NULL,
          issue_url TEXT NOT NULL,
          issue_updated_at TEXT NOT NULL,
          issue_snapshot_json TEXT NOT NULL,
          project_key TEXT,
          project_revision TEXT,
          project_snapshot_json TEXT,
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
          revision INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(repo, issue_number)
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
      `);

      if (version.user_version < 1) {
        this.ensureColumn("auditor_profile_id", "TEXT");
        this.ensureColumn("auditor_terminal_handle", "TEXT");
        this.ensureColumn("auditor_task_id", "TEXT");
        this.ensureColumn("auditor_dispatch_id", "TEXT");
        this.ensureColumn("audit_head_sha", "TEXT");
        this.ensureColumn("dispatch_attempt", "INTEGER NOT NULL DEFAULT 0");
        this.ensureColumn(
          "dispatch_probe_pending",
          "INTEGER NOT NULL DEFAULT 0",
        );
        this.ensureColumn("revision", "INTEGER NOT NULL DEFAULT 0");
        this.ensureColumn("project_key", "TEXT");
        this.ensureColumn("project_revision", "TEXT");
        this.ensureColumn("project_snapshot_json", "TEXT");
        this.db.exec("PRAGMA user_version = 1");
      }

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the migration error.
      }
      throw err;
    }
  }

  private ensureColumn(name: string, sqlType: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{
      name: string;
    }>;
    if (cols.some((c) => c.name === name)) return;
    this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${sqlType}`);
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

  resolveJobProject(
    id: string,
    repositories: RepoConfig[],
    mode: "persist_legacy" | "read_only" = "persist_legacy",
  ):
    | {
        ok: true;
        job: Job;
        project: RepoConfig;
        source: "snapshot" | "backfilled" | "legacy";
      }
    | { ok: false; error: string } {
    const job = this.getJob(id);
    if (!job) return { ok: false, error: `job not found: ${id}` };

    const snapshotFields = [
      job.project_key,
      job.project_revision,
      job.project_snapshot_json,
    ];
    if (snapshotFields.some((value) => value !== null)) {
      if (snapshotFields.some((value) => value === null)) {
        return {
          ok: false,
          error: `job ${id} has incomplete project snapshot provenance`,
        };
      }
      const parsed = parseProjectSnapshot(job.project_snapshot_json!);
      if (!parsed.ok) {
        return { ok: false, error: `job ${id} ${parsed.error}` };
      }
      if (
        parsed.snapshot.key !== job.project_key ||
        parsed.snapshot.key !== job.repo.toLowerCase() ||
        parsed.snapshot.baseRef !== job.base_ref ||
        parsed.revision !== job.project_revision
      ) {
        return {
          ok: false,
          error: `job ${id} project snapshot provenance does not match the claim`,
        };
      }
      return {
        ok: true,
        job,
        project: projectConfigFromSnapshot(parsed.snapshot),
        source: "snapshot",
      };
    }

    const matches = repositories.filter((repo) => {
      const snapshot = createProjectSnapshot(repo).snapshot;
      return (
        snapshot.key === job.repo.toLowerCase() &&
        snapshot.baseRef === job.base_ref
      );
    });
    if (matches.length !== 1) {
      return {
        ok: false,
        error: `legacy active job project ${job.repo} does not uniquely match config (${matches.length} matches)`,
      };
    }

    const project = createProjectSnapshot(matches[0]!);
    const projectConfig = projectConfigFromSnapshot(project.snapshot);
    if (mode === "read_only") {
      return {
        ok: true,
        job,
        project: projectConfig,
        source: "legacy",
      };
    }

    const updated = this.updateJobIf(id, job.revision, {
      project_key: project.snapshot.key,
      project_revision: project.revision,
      project_snapshot_json: project.json,
    });
    if (!updated) {
      return {
        ok: false,
        error: `job ${id} changed while backfilling project snapshot`,
      };
    }
    return {
      ok: true,
      job: updated,
      project: projectConfig,
      source: "backfilled",
    };
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
    project: RepoConfig;
    issue: IssueCandidate;
    baseSha: string;
    implementerProfileId: string;
  }): { ok: true; job: Job } | { ok: false; error: string } {
    if (!input.baseSha) {
      return { ok: false, error: "claim requires a base SHA" };
    }
    const project = createProjectSnapshot(input.project);
    const now = isoNow();
    const issueSnapshot = JSON.stringify(input.issue);

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
        .get(project.snapshot.key, input.issue.number) as
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
              project_key = ?,
              project_revision = ?,
              project_snapshot_json = ?,
              state = 'claimed',
              base_ref = ?,
              base_sha = ?,
              branch = NULL,
              worktree_id = NULL,
              worktree_path = NULL,
              implementer_profile_id = ?,
              implementer_terminal_handle = NULL,
              implementer_task_id = NULL,
              implementer_dispatch_id = NULL,
              auditor_profile_id = NULL,
              auditor_terminal_handle = NULL,
              auditor_task_id = NULL,
              auditor_dispatch_id = NULL,
              dispatch_attempt = 0,
              dispatch_probe_pending = 0,
              controller_terminal_handle = NULL,
              audit_round = 0,
              audit_result_json = NULL,
              audit_head_sha = NULL,
              pr_number = NULL,
              pr_url = NULL,
              merged_at = NULL,
              last_error = NULL,
              head_sha = NULL,
              revision = 0,
              created_at = ?,
              updated_at = ?
            WHERE repo = ? AND issue_number = ?`,
          )
          .run(
            input.id,
            input.issue.url,
            input.issue.updatedAt,
            issueSnapshot,
            project.snapshot.key,
            project.revision,
            project.json,
            project.snapshot.baseRef,
            input.baseSha,
            input.implementerProfileId,
            now,
            now,
            project.snapshot.key,
            input.issue.number,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO jobs (
              id, repo, issue_number, issue_url, issue_updated_at,
              issue_snapshot_json, project_key, project_revision,
              project_snapshot_json, state, base_ref, base_sha,
              implementer_profile_id, audit_round, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            input.id,
            project.snapshot.key,
            input.issue.number,
            input.issue.url,
            input.issue.updatedAt,
            issueSnapshot,
            project.snapshot.key,
            project.revision,
            project.json,
            project.snapshot.baseRef,
            input.baseSha,
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

  updateJob(id: string, patch: JobPatch): Job {
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
        `UPDATE jobs SET ${sets}, revision = revision + 1, updated_at = ? WHERE id = ?`,
      )
      .run(...values, isoNow(), id);
    const job = this.getJob(id);
    if (!job) throw new Error(`job not found after update: ${id}`);
    return job;
  }

  updateJobIf(
    id: string,
    expectedRevision: number,
    patch: JobPatch,
  ): Job | null {
    const allowed = Object.keys(patch) as Array<keyof JobPatch>;
    if (allowed.length === 0) {
      const job = this.getJob(id);
      return job?.revision === expectedRevision ? job : null;
    }

    const sets = allowed.map((key) => `${key} = ?`).join(", ");
    const values = allowed.map((key) => patch[key] ?? null);
    const result = this.db
      .prepare(
        `UPDATE jobs SET ${sets}, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(...values, isoNow(), id, expectedRevision);
    if (result.changes === 0) return null;
    return this.getJob(id);
  }
}

function isoNow(): string {
  return new Date().toISOString();
}
