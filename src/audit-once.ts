import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultLedgerPath,
  defaultLockPath,
  getAuditorProfile,
  getImplementerProfile,
  loadConfig,
} from "./config.js";
import {
  auditResultMatchesShas,
  evaluateAuditGate,
  loadAuditResult,
  trackedDirty,
  type GateDecision,
} from "./audit-gate.js";
import {
  currentBranch,
  git,
  logOnelineSince,
  revParse,
} from "./git.js";
import { Ledger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import { orcaStatus, requireOrcaCli } from "./orca.js";
import {
  dispatchTaskEnsured,
  ensureAgentTerminal,
  ensureControllerTerminal,
  orchestrationTaskStatus,
  setWorktreeProgress,
  waitWorkerDone,
} from "./orca-runtime.js";
import { renderAuditorSpec, renderReworkSpec } from "./prompts.js";
import type { HarnessConfig, Job, RepoConfig } from "./types.js";

export type AuditOnceResult = {
  ok: boolean;
  jobId?: string;
  message: string;
  details?: Record<string, unknown> & {
    gate?: GateDecision;
    gateFail?: boolean;
  };
};

export function auditOnce(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  /** When true, after fail rework once and re-audit until pass/block (M3 loop). */
  withRework?: boolean;
}): AuditOnceResult {
  const config = loadConfig(options.configPath);
  const lock = acquireLock(options.lockPath ?? defaultLockPath());
  if (!lock.ok) {
    return { ok: false, message: lock.error ?? "lock failed" };
  }
  const ledger = new Ledger(options.ledgerPath ?? defaultLedgerPath());
  try {
    return auditOnceLocked(config, ledger, {
      withRework: options.withRework ?? true,
    });
  } finally {
    ledger.close();
    lock.release();
  }
}

function auditOnceLocked(
  config: HarnessConfig,
  ledger: Ledger,
  options: { withRework: boolean },
): AuditOnceResult {
  const log = (msg: string) => {
    process.stdout.write(`[audit-once] ${msg}\n`);
  };

  const orcaCli = requireOrcaCli(config);
  const st = orcaStatus(orcaCli);
  if (!st.ok) {
    return { ok: false, message: `orca not ready: ${st.error ?? "unknown"}` };
  }

  let job = ledger.getActiveJob();
  if (!job) {
    return { ok: false, message: "no active job" };
  }

  if (job.state === "audit_passed") {
    return {
      ok: true,
      jobId: job.id,
      message: "already audit_passed; use harness publish-once for M4",
      details: { head_sha: job.head_sha, audit_round: job.audit_round },
    };
  }
  if (job.state === "publishing" || job.state === "awaiting_merge" || job.state === "merged") {
    return {
      ok: true,
      jobId: job.id,
      message: `job already past audit (state=${job.state})`,
      details: { pr_url: job.pr_url },
    };
  }

  if (
    job.state !== "awaiting_audit" &&
    job.state !== "auditing" &&
    job.state !== "reworking"
  ) {
    return {
      ok: false,
      jobId: job.id,
      message: `job state ${job.state} is not ready for audit (need awaiting_audit|auditing|reworking)`,
    };
  }

  const repo = config.repositories.find((r) => r.github === job!.repo);
  if (!repo) {
    return { ok: false, jobId: job.id, message: `repo not in config: ${job.repo}` };
  }

  const auditor = getAuditorProfile(config);
  if (auditor.role !== "auditor" || !auditor.readonly) {
    return {
      ok: false,
      message: `auditor profile must be role=auditor readonly=true (got ${auditor.id})`,
    };
  }
  const implementer = getImplementerProfile(config);

  const controller = ensureControllerTerminal(orcaCli, config);
  if (!controller.ok) {
    return { ok: false, jobId: job.id, message: controller.error };
  }
  job = ledger.updateJob(job.id, {
    controller_terminal_handle: controller.handle,
  });

  // Max rounds of audit (each fail → rework → audit counts as progress toward max)
  const maxRounds = config.maxAuditRounds;

  while (true) {
    // If reworking, finish implementer first
    if (job.state === "reworking") {
      const rework = runReworkPhase(config, ledger, orcaCli, job, repo, implementer, log);
      if (!rework.ok) return rework;
      job = ledger.getJob(job.id)!;
    }

    // Ensure we are ready to audit
    if (job.state === "awaiting_audit" || job.state === "auditing" || job.state === "reworking") {
      // after rework, state becomes awaiting_audit
    }

    if (job.state !== "awaiting_audit" && job.state !== "auditing") {
      job = ledger.updateJob(job.id, { state: "awaiting_audit" });
    }

    const round =
      job.state === "auditing" && job.audit_round > 0
        ? job.audit_round
        : (job.audit_round ?? 0) + 1;
    if (round > maxRounds) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: `audit rounds exhausted (${maxRounds})`,
      });
      return {
        ok: false,
        jobId: job.id,
        message: `blocked: audit rounds exhausted (${maxRounds})`,
      };
    }

    log(`starting audit round ${round}/${maxRounds}`);
    const audited = runAuditPhase(
      config,
      ledger,
      orcaCli,
      job,
      repo,
      auditor,
      round,
      log,
    );
    if (!audited.ok && !audited.details?.gateFail) {
      return audited;
    }

    job = ledger.getJob(job.id)!;
    if (job.state === "audit_passed") {
      return {
        ok: true,
        jobId: job.id,
        message: "audit passed; stopped before PR (M3)",
        details: audited.details,
      };
    }

    const gate = audited.details?.gate;
    if (gate?.uncertain) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: audited.message,
      });
      setWorktreeProgress(
        orcaCli,
        job.worktree_id!,
        `harness: blocked after uncertain audit r${round}`,
        "in-review",
      );
      return audited;
    }

    // gate failed
    if (!options.withRework) {
      return {
        ok: false,
        jobId: job.id,
        message: audited.message,
        details: audited.details,
      };
    }

    if (round >= maxRounds) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: `audit failed on final round ${round}: ${audited.message}`,
      });
      setWorktreeProgress(
        orcaCli,
        job.worktree_id!,
        `harness: blocked after audit r${round}`,
        "in-progress",
      );
      return {
        ok: false,
        jobId: job.id,
        message: job.last_error ?? audited.message,
        details: audited.details,
      };
    }

    // enter rework
    job = ledger.updateJob(job.id, {
      state: "reworking",
      last_error: audited.message,
      // clear auditor session for next round
      auditor_terminal_handle: null,
      auditor_task_id: null,
      auditor_dispatch_id: null,
      implementer_task_id: null,
      implementer_dispatch_id: null,
      dispatch_attempt: 0,
      dispatch_probe_pending: 0,
    });
    log(`audit failed; entering rework (next round will be ${round + 1})`);
    // loop continues → rework then audit
  }
}

function runAuditPhase(
  config: HarnessConfig,
  ledger: Ledger,
  orcaCli: string,
  job: Job,
  repo: RepoConfig,
  auditor: ReturnType<typeof getAuditorProfile>,
  round: number,
  log: (m: string) => void,
): AuditOnceResult {
  if (!job.worktree_id || !job.worktree_path || !job.base_sha) {
    return {
      ok: false,
      jobId: job.id,
      message: "job missing worktree/base_sha",
    };
  }
  const worktreeId = job.worktree_id;
  const worktreePath = job.worktree_path;
  const baseSha = job.base_sha;

  const headSha = revParse(worktreePath, "HEAD");
  if (!headSha) {
    return { ok: false, jobId: job.id, message: "cannot read HEAD" };
  }
  if (headSha === baseSha) {
    return {
      ok: false,
      jobId: job.id,
      message: "HEAD equals base_sha; nothing to audit",
    };
  }

  const resultPath = join(worktreePath, ".harness", "audit-result.json");
  mkdirSync(join(worktreePath, ".harness"), { recursive: true });

  // Snapshot tracked cleanliness before audit
  const dirtyBefore = trackedDirty(worktreePath);
  if (dirtyBefore) {
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: `tracked files dirty before audit:\n${dirtyBefore}`,
    });
    return {
      ok: false,
      jobId: job.id,
      message: "tracked files dirty before audit",
      details: { dirtyBefore },
    };
  }

  // Resume only evidence tied to this job's current audit task and round.
  const existing = loadAuditResult(resultPath);
  const sameRoundTask =
    job.state === "auditing" &&
    job.audit_round === round &&
    job.audit_head_sha === headSha &&
    Boolean(job.auditor_task_id);
  const completedSameRoundTask =
    sameRoundTask &&
    orchestrationTaskStatus(
      orcaCli,
      job.auditor_task_id!,
    )?.toLowerCase() === "completed";
  const canReuseResult =
    completedSameRoundTask &&
    existing.ok &&
    Boolean(
      existing.result &&
        auditResultMatchesShas(existing.result, baseSha, headSha),
    );

  if (completedSameRoundTask && !canReuseResult) {
    const error =
      existing.error ??
      "completed audit task produced a result for different base/head SHAs";
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: error,
    });
    return { ok: false, jobId: job.id, message: error };
  }

  if (!canReuseResult) {
    const title = `issue-${job.issue_number}-audit-r${round}`;
    const resumingRound =
      sameRoundTask &&
      Boolean(job.auditor_terminal_handle);
    if (!sameRoundTask) {
      try {
        rmSync(resultPath, { force: true });
      } catch (err) {
        const error = `failed to clear stale audit result: ${(err as Error).message}`;
        job = ledger.updateJob(job.id, {
          state: "blocked",
          last_error: error,
        });
        return { ok: false, jobId: job.id, message: error };
      }
    }
    let handle = resumingRound ? job.auditor_terminal_handle : null;
    if (!handle) {
      log(`creating auditor terminal ${title}`);
      handle = ensureAgentTerminal(orcaCli, worktreeId, auditor, title, {
        forceNew: true,
      });
    } else {
      log(`resuming auditor terminal ${handle} for round ${round}`);
    }
    if (!handle) {
      job = ledger.updateJob(job.id, {
        state: "blocked",
        last_error: "failed to create auditor terminal",
      });
      return {
        ok: false,
        jobId: job.id,
        message: "failed to create auditor terminal",
      };
    }

    if (!resumingRound) {
      job = ledger.updateJob(job.id, {
        state: "auditing",
        audit_round: round,
        auditor_profile_id: auditor.id,
        auditor_terminal_handle: handle,
        auditor_task_id: null,
        auditor_dispatch_id: null,
        dispatch_attempt: 0,
        dispatch_probe_pending: 0,
        audit_head_sha: headSha,
        head_sha: headSha,
      });
    }
    setWorktreeProgress(
      orcaCli,
      worktreeId,
      `harness: auditing r${round} via ${auditor.id}`,
      "in-review",
    );

    if (!job.auditor_task_id || job.dispatch_probe_pending === 1) {
      const spec = renderAuditorSpec({
        repo: repo.github,
        issueNumber: job.issue_number,
        issueUrl: job.issue_url,
        baseSha,
        headSha,
        branch: job.branch ?? currentBranch(worktreePath) ?? "",
        worktreePath,
        profileId: auditor.id,
        orcaAgent: auditor.orcaAgent,
        invokeHint: auditor.invokeHint,
        auditRound: round,
        resultPath: ".harness/audit-result.json",
      });
      const jobId = job.id;
      const controllerHandle = job.controller_terminal_handle!;
      const existingDispatch =
        job.dispatch_probe_pending === 1 && job.auditor_task_id
          ? {
              taskId: job.auditor_task_id,
              dispatchId: job.auditor_dispatch_id,
              to: handle,
              attempt: (job.dispatch_attempt === 2 ? 2 : 1) as 1 | 2,
            }
          : undefined;
      const ensured = dispatchTaskEnsured(orcaCli, {
        title: `Audit ${repo.github}#${job.issue_number} r${round}`,
        displayName: `issue-${job.issue_number}-audit-r${round}`,
        spec,
        to: handle,
        from: controllerHandle,
        idleTimeoutMs: 120_000,
        onLog: log,
        existingDispatch,
        onDispatched: (event) => {
          job = ledger.updateJob(jobId, {
            state: "auditing",
            auditor_terminal_handle: event.to,
            auditor_task_id: event.taskId,
            auditor_dispatch_id: event.dispatchId,
            dispatch_attempt: event.attempt,
            dispatch_probe_pending: 1,
            last_error: null,
          });
        },
        recreateAgentTerminal: () =>
          ensureAgentTerminal(orcaCli, worktreeId, auditor, title, {
            forceNew: true,
          }),
      });
      if (!ensured.ok) {
        const hasLastTask = ensured.lastTaskId !== undefined;
        const taskId = ensured.lastTaskId ?? job.auditor_task_id;
        const dispatchId = hasLastTask
          ? ensured.lastDispatchId ?? null
          : job.auditor_dispatch_id;
        const shouldBlock =
          ensured.kind === "exhausted" ||
          (hasLastTask && dispatchId === null);
        job = ledger.updateJob(job.id, {
          state: shouldBlock ? "blocked" : job.state,
          last_error: `dispatch ${ensured.kind}: ${ensured.error}`,
          auditor_terminal_handle: ensured.to,
          auditor_task_id: taskId,
          auditor_dispatch_id: dispatchId,
          dispatch_attempt: hasLastTask
            ? ensured.lastAttempt ?? 0
            : job.dispatch_attempt,
          dispatch_probe_pending:
            shouldBlock || !taskId ? 0 : 1,
        });
        return { ok: false, jobId: job.id, message: ensured.error };
      }

      job = ledger.updateJob(job.id, {
        state: "auditing",
        auditor_task_id: ensured.taskId,
        auditor_dispatch_id: ensured.dispatchId,
        auditor_terminal_handle: ensured.to,
        dispatch_attempt: ensured.attempt,
        dispatch_probe_pending: 0,
        last_error: null,
      });
      log(
        `dispatch ok attempt=${ensured.attempt} task=${ensured.taskId} (${ensured.acceptReason})`,
      );
    } else {
      log(`audit task already accepted: ${job.auditor_task_id}`);
    }

    const done = waitWorkerDone(orcaCli, {
      controllerHandle: job.controller_terminal_handle!,
      taskId: job.auditor_task_id!,
      dispatchId: job.auditor_dispatch_id,
      timeoutMs: config.auditTimeoutMinutes * 60_000,
      onTick: (info) => log(info),
    });
    if (!done.ok) {
      // worker_done may be lost; completed task provenance is the fallback.
      const late = loadAuditResult(resultPath);
      const completed =
        done.error.startsWith("timeout waiting for worker_done") &&
        orchestrationTaskStatus(
          orcaCli,
          job.auditor_task_id!,
        )?.toLowerCase() === "completed";
      if (
        !(
          completed &&
          late.ok &&
          late.result &&
          auditResultMatchesShas(late.result, baseSha, headSha)
        )
      ) {
        job = ledger.updateJob(job.id, {
          state: "blocked",
          last_error: done.error,
        });
        return { ok: false, jobId: job.id, message: done.error };
      }
      log(
        "worker_done missing but same-round task completed with a valid result; continuing",
      );
    } else {
      log("received auditor worker_done");
    }
  } else {
    log(
      "M5 resume: reusing valid audit result from the completed same-round task",
    );
    job = ledger.updateJob(job.id, {
      state: "auditing",
      audit_round: round,
      audit_head_sha: headSha,
      head_sha: headSha,
      dispatch_attempt: 0,
      dispatch_probe_pending: 0,
    });
  }

  // Cleanliness: tracked files must not change
  const dirtyAfter = trackedDirty(worktreePath);
  if (dirtyAfter) {
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: `auditor modified tracked files:\n${dirtyAfter}`,
    });
    return {
      ok: false,
      jobId: job.id,
      message: "auditor modified tracked files",
      details: { dirtyAfter },
    };
  }

  // HEAD must be unchanged during audit
  const headAfter = revParse(worktreePath, "HEAD");
  if (!headAfter || headAfter !== headSha) {
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: `HEAD changed during audit: ${headSha} → ${headAfter}`,
    });
    return {
      ok: false,
      jobId: job.id,
      message: "HEAD changed during audit",
    };
  }

  const loaded = loadAuditResult(resultPath);
  const gate = evaluateAuditGate(loaded.result ?? null, {
    expectedBaseSha: baseSha,
    expectedHeadSha: headSha,
    parseError: loaded.error,
  });

  // Persist result
  const resultJson = loaded.result
    ? JSON.stringify(loaded.result, null, 2)
    : JSON.stringify({ error: loaded.error });
  job = ledger.updateJob(job.id, {
    audit_result_json: resultJson,
  });
  // also archive round copy
  try {
    writeFileSync(
      join(worktreePath, ".harness", `audit-result.r${round}.json`),
      resultJson,
    );
  } catch {
    // best-effort
  }

  if (gate.pass) {
    job = ledger.updateJob(job.id, {
      state: "audit_passed",
      dispatch_attempt: 0,
      dispatch_probe_pending: 0,
      last_error: null,
    });
    setWorktreeProgress(
      orcaCli,
      worktreeId,
      `harness: audit_passed r${round} (M3 stop, no PR)`,
      "in-review",
    );
    return {
      ok: true,
      jobId: job.id,
      message: gate.reason,
      details: {
        round,
        gate,
        headSha,
        commits: logOnelineSince(worktreePath, baseSha),
      },
    };
  }

  // Keep the same round recoverable until the caller moves it to rework.
  job = ledger.updateJob(job.id, {
    state: "auditing",
    dispatch_attempt: 0,
    dispatch_probe_pending: 0,
    last_error: gate.reason,
  });
  setWorktreeProgress(
    orcaCli,
    worktreeId,
    `harness: audit fail r${round} — ${gate.reason}`.slice(0, 180),
    "in-review",
  );
  return {
    ok: false,
    jobId: job.id,
    message: gate.reason,
    details: { round, gate, gateFail: true, headSha },
  };
}

function runReworkPhase(
  config: HarnessConfig,
  ledger: Ledger,
  orcaCli: string,
  job: Job,
  repo: RepoConfig,
  implementer: ReturnType<typeof getImplementerProfile>,
  log: (m: string) => void,
): AuditOnceResult {
  if (!job.worktree_id || !job.worktree_path || !job.base_sha) {
    return { ok: false, jobId: job.id, message: "missing worktree for rework" };
  }
  const worktreeId = job.worktree_id;
  const worktreePath = job.worktree_path;
  const baseSha = job.base_sha;
  const blockRework = (error: string): AuditOnceResult => {
    job = ledger.updateJob(job.id, {
      state: "blocked",
      last_error: error,
    });
    return { ok: false, jobId: job.id, message: error };
  };
  const auditHeadSha = job.audit_head_sha;
  if (!auditHeadSha) {
    return blockRework("rework missing audited HEAD");
  }
  const inspectReworkCompletion = ():
    | { ok: true; headSha: string; commits: number }
    | { ok: false; error: string } => {
    const headSha = revParse(worktreePath, "HEAD");
    if (!headSha) {
      return { ok: false, error: "cannot read rework HEAD" };
    }
    if (headSha === auditHeadSha) {
      return {
        ok: false,
        error: "rework produced no commits after audited HEAD",
      };
    }
    const ancestry = git(worktreePath, [
      "merge-base",
      "--is-ancestor",
      auditHeadSha,
      headSha,
    ]);
    if (!ancestry.ok && ancestry.stderr) {
      return {
        ok: false,
        error: `cannot verify rework ancestry: ${ancestry.stderr}`,
      };
    }
    if (!ancestry.ok) {
      return {
        ok: false,
        error: "rework HEAD is not a descendant of audited HEAD",
      };
    }
    const count = git(worktreePath, [
      "rev-list",
      "--count",
      `${auditHeadSha}..${headSha}`,
    ]);
    if (!count.ok) {
      return {
        ok: false,
        error:
          `cannot count rework commits: ` +
          `${count.stderr || "unknown Git error"}`,
      };
    }
    const commits = Number(count.stdout);
    if (!Number.isSafeInteger(commits)) {
      return {
        ok: false,
        error: `invalid rework commit count: ${count.stdout}`,
      };
    }
    if (commits < 1) {
      return {
        ok: false,
        error: "rework produced zero commits after audited HEAD",
      };
    }
    const dirty = trackedDirty(worktreePath);
    if (dirty) {
      return {
        ok: false,
        error: `tracked files dirty after rework:\n${dirty}`,
      };
    }
    return { ok: true, headSha, commits };
  };
  const finishRework = (
    completion: { headSha: string; commits: number },
  ): AuditOnceResult => {
    job = ledger.updateJob(job.id, {
      state: "awaiting_audit",
      head_sha: completion.headSha,
      last_error: null,
      // force new audit task next
      auditor_task_id: null,
      auditor_dispatch_id: null,
      auditor_terminal_handle: null,
      dispatch_attempt: 0,
      dispatch_probe_pending: 0,
    });
    log(
      `rework done head=${completion.headSha.slice(0, 7)} ` +
      `commits_since_audit=${completion.commits}`,
    );
    return {
      ok: true,
      jobId: job.id,
      message: "rework complete; ready for re-audit",
      details: completion,
    };
  };
  if (job.implementer_task_id) {
    const recovered = inspectReworkCompletion();
    if (recovered.ok) {
      log(
        "M5 resume: committed rework already present; " +
        "skipping worker_done wait",
      );
      return finishRework(recovered);
    }
  }
  const dispatchFixedPointError = (): string | null => {
    const reworkStartHead = revParse(worktreePath, "HEAD");
    if (reworkStartHead !== auditHeadSha) {
      return (
        `rework HEAD changed before rework dispatch: expected ${auditHeadSha}, ` +
        `got ${reworkStartHead ?? "unreadable"}`
      );
    }
    const dirtyBeforeRework = trackedDirty(worktreePath);
    if (dirtyBeforeRework) {
      return `tracked files dirty before rework dispatch:\n${dirtyBeforeRework}`;
    }
    return null;
  };
  if (!job.implementer_task_id) {
    const fixedPointError = dispatchFixedPointError();
    if (fixedPointError) return blockRework(fixedPointError);
  }

  const needsDispatch =
    !job.implementer_task_id || job.dispatch_probe_pending === 1;
  let handle = job.implementer_terminal_handle;
  if (needsDispatch) {
    handle = ensureAgentTerminal(
      orcaCli,
      worktreeId,
      implementer,
      `issue-${job.issue_number}-${implementer.orcaAgent}`,
    );
    if (handle && handle !== job.implementer_terminal_handle) {
      job = ledger.updateJob(job.id, {
        implementer_terminal_handle: handle,
      });
    }
  }
  if (needsDispatch) {
    if (!handle) {
      return {
        ok: false,
        jobId: job.id,
        message: "no implementer terminal for rework",
      };
    }
    const dispatchHandle = handle;
    const auditJson = job.audit_result_json ?? "{}";
    const spec = renderReworkSpec({
      repo: repo.github,
      issueNumber: job.issue_number,
      issueUrl: job.issue_url,
      baseSha,
      branch: job.branch ?? "",
      worktreePath,
      profileId: implementer.id,
      invokeHint: implementer.invokeHint,
      auditRound: job.audit_round,
      auditResultJson: auditJson,
    });
    const jobId = job.id;
    const issueNumber = job.issue_number;
    const existingDispatch =
      job.dispatch_probe_pending === 1 && job.implementer_task_id
        ? {
            taskId: job.implementer_task_id,
            dispatchId: job.implementer_dispatch_id,
            to: dispatchHandle,
            attempt: (job.dispatch_attempt === 2 ? 2 : 1) as 1 | 2,
          }
        : undefined;
    let taskCreateGuardError: string | null = null;
    const ensured = dispatchTaskEnsured(orcaCli, {
      title: `Rework ${repo.github}#${job.issue_number} after audit r${job.audit_round}`,
      displayName: `issue-${job.issue_number}-rework-r${job.audit_round}`,
      spec,
      to: dispatchHandle,
      from: job.controller_terminal_handle!,
      onLog: log,
      existingDispatch,
      beforeTaskCreate: () => {
        taskCreateGuardError = dispatchFixedPointError();
        return taskCreateGuardError;
      },
      onDispatched: (event) => {
        job = ledger.updateJob(jobId, {
          state: "reworking",
          implementer_terminal_handle: event.to,
          implementer_task_id: event.taskId,
          implementer_dispatch_id: event.dispatchId,
          dispatch_attempt: event.attempt,
          dispatch_probe_pending: 1,
          last_error: null,
        });
      },
      recreateAgentTerminal: () => {
        const replacement = ensureAgentTerminal(
          orcaCli,
          worktreeId,
          implementer,
          `issue-${issueNumber}-${implementer.orcaAgent}`,
          { forceNew: true },
        );
        if (replacement) {
          job = ledger.updateJob(jobId, {
            implementer_terminal_handle: replacement,
          });
        }
        return replacement;
      },
    });
    if (!ensured.ok) {
      const hasLastTask = ensured.lastTaskId !== undefined;
      const taskId = ensured.lastTaskId ?? job.implementer_task_id;
      const dispatchId = hasLastTask
        ? ensured.lastDispatchId ?? null
        : job.implementer_dispatch_id;
      const shouldBlock =
        taskCreateGuardError !== null ||
        ensured.kind === "exhausted" ||
        (hasLastTask && dispatchId === null);
      job = ledger.updateJob(job.id, {
        state: shouldBlock ? "blocked" : "reworking",
        last_error:
          taskCreateGuardError ??
          `dispatch ${ensured.kind}: ${ensured.error}`,
        implementer_terminal_handle: ensured.to,
        implementer_task_id: taskId,
        implementer_dispatch_id: dispatchId,
        dispatch_attempt: hasLastTask
          ? ensured.lastAttempt ?? 0
          : job.dispatch_attempt,
        dispatch_probe_pending:
          shouldBlock || !taskId ? 0 : 1,
      });
      return {
        ok: false,
        jobId: job.id,
        message: taskCreateGuardError ?? ensured.error,
      };
    }

    job = ledger.updateJob(job.id, {
      state: "reworking",
      implementer_terminal_handle: ensured.to,
      implementer_task_id: ensured.taskId,
      implementer_dispatch_id: ensured.dispatchId,
      dispatch_attempt: ensured.attempt,
      dispatch_probe_pending: 0,
      last_error: null,
    });
    log(
      `dispatch ok attempt=${ensured.attempt} rework task=${ensured.taskId}`,
    );
  } else {
    log(`rework task already accepted: ${job.implementer_task_id}`);
  }

  setWorktreeProgress(
    orcaCli,
    worktreeId,
    `harness: reworking after audit r${job.audit_round}`,
    "in-progress",
  );
  const done = waitWorkerDone(orcaCli, {
    controllerHandle: job.controller_terminal_handle!,
    taskId: job.implementer_task_id!,
    dispatchId: job.implementer_dispatch_id,
    timeoutMs: config.implementTimeoutMinutes * 60_000,
    onTick: (info) => log(info),
  });
  if (!done.ok) {
    if (done.escalated) {
      return blockRework(done.error);
    }
    const recovered = inspectReworkCompletion();
    if (recovered.ok) {
      log(
        "worker_done missing but committed rework exists; " +
        "continuing re-audit (M5)",
      );
      return finishRework(recovered);
    }
    return blockRework(`${done.error}; ${recovered.error}`);
  }

  const completion = inspectReworkCompletion();
  return completion.ok
    ? finishRework(completion)
    : blockRework(completion.error);
}
