import { existsSync, readFileSync } from "node:fs";
import { execFile } from "./exec.js";
import type { AuditFinding, AuditResult } from "./types.js";

export type GateDecision = {
  pass: boolean;
  reason: string;
  result: AuditResult | null;
  blockingStandards: number;
  blockingSpec: number;
  validationFailures: number;
  uncertain: boolean;
};

export function loadAuditResult(path: string): {
  ok: boolean;
  result?: AuditResult;
  error?: string;
} {
  if (!existsSync(path)) {
    return { ok: false, error: `audit result file missing: ${path}` };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const error = auditResultError(raw);
    if (error) {
      return { ok: false, error: `invalid audit result: ${error}` };
    }
    return { ok: true, result: raw as AuditResult };
  } catch (err) {
    return {
      ok: false,
      error: `invalid audit JSON: ${(err as Error).message}`,
    };
  }
}

export function evaluateAuditGate(
  result: AuditResult | null,
  options: {
    expectedBaseSha: string;
    expectedHeadSha: string;
    parseError?: string;
  },
): GateDecision {
  if (!result) {
    return {
      pass: false,
      reason: options.parseError ?? "missing audit result",
      result: null,
      blockingStandards: 0,
      blockingSpec: 0,
      validationFailures: 0,
      uncertain: true,
    };
  }

  if (result.status === "uncertain") {
    return {
      pass: false,
      reason: "auditor reported uncertain",
      result,
      blockingStandards: countBlocking(
        result.standards?.documented_standard_violations,
      ),
      blockingSpec:
        countBlocking(result.spec?.missing_or_partial) +
        countBlocking(result.spec?.incorrect_implementation) +
        countBlocking(result.spec?.scope_creep),
      validationFailures: countValidationFailures(result),
      uncertain: true,
    };
  }

  // SHA integrity
  if (
    result.base_sha &&
    !shaMatch(result.base_sha, options.expectedBaseSha)
  ) {
    return {
      pass: false,
      reason: `audit base_sha mismatch: ${result.base_sha} vs ${options.expectedBaseSha}`,
      result,
      blockingStandards: 0,
      blockingSpec: 0,
      validationFailures: 0,
      uncertain: true,
    };
  }
  if (
    result.head_sha &&
    !shaMatch(result.head_sha, options.expectedHeadSha)
  ) {
    return {
      pass: false,
      reason: `audit head_sha mismatch (stale audit): ${result.head_sha} vs ${options.expectedHeadSha}`,
      result,
      blockingStandards: 0,
      blockingSpec: 0,
      validationFailures: 0,
      uncertain: true,
    };
  }

  const blockingStandards = countBlocking(
    result.standards?.documented_standard_violations,
  );
  // smells are never blocking by themselves
  const blockingSpec =
    countBlocking(result.spec?.missing_or_partial) +
    countBlocking(result.spec?.incorrect_implementation) +
    countBlocking(result.spec?.scope_creep);
  const validationFailures = countValidationFailures(result);

  const statusFail = result.status === "fail";
  const computedFail =
    blockingStandards > 0 || blockingSpec > 0 || validationFailures > 0;
  const uncertain = statusFail && !computedFail;

  if (statusFail || computedFail) {
    return {
      pass: false,
      reason: uncertain
        ? "audit failed without actionable evidence"
        : `blocking findings standards=${blockingStandards} spec=${blockingSpec} validation=${validationFailures}`,
      result,
      blockingStandards,
      blockingSpec,
      validationFailures,
      uncertain,
    };
  }

  if (result.status !== "pass") {
    return {
      pass: false,
      reason: `unexpected status ${result.status}`,
      result,
      blockingStandards,
      blockingSpec,
      validationFailures,
      uncertain: true,
    };
  }

  return {
    pass: true,
    reason: "audit gate passed",
    result,
    blockingStandards: 0,
    blockingSpec: 0,
    validationFailures: 0,
    uncertain: false,
  };
}

export function auditResultMatchesShas(
  result: AuditResult,
  expectedBaseSha: string,
  expectedHeadSha: string,
): boolean {
  return (
    shaMatch(result.base_sha, expectedBaseSha) &&
    shaMatch(result.head_sha, expectedHeadSha)
  );
}

/** Tracked working tree dirty? Untracked files (e.g. .pi, .harness) ignored. */
export function trackedDirty(worktreePath: string): string {
  const r = execFile("git", [
    "-C",
    worktreePath,
    "status",
    "--porcelain",
    "-uno",
  ]);
  return r.ok
    ? r.stdout.trim()
    : `git status failed: ${r.stderr.trim() || r.error || `exit ${r.code}`}`;
}

function countBlocking(findings: AuditFinding[] | undefined): number {
  if (!findings?.length) return 0;
  return findings.filter((f) => f.blocking !== false).length;
}

function countValidationFailures(result: AuditResult): number {
  const cmds = result.validation?.commands ?? [];
  return cmds.filter((c) => !c.ok || c.exit_code !== 0).length;
}

function shaMatch(a: string, b: string): boolean {
  return (
    fullSha(a) &&
    fullSha(b) &&
    a.toLowerCase() === b.toLowerCase()
  );
}

function auditResultError(value: unknown): string | null {
  if (!isRecord(value)) return "root must be an object";
  if (!["pass", "fail", "uncertain"].includes(String(value.status))) {
    return "status must be pass, fail, or uncertain";
  }
  if (!fullSha(value.base_sha)) return "base_sha must be a full 40-character SHA";
  if (!fullSha(value.head_sha)) return "head_sha must be a full 40-character SHA";

  if (!isRecord(value.standards)) return "standards must be an object";
  if (
    !findingArray(value.standards.documented_standard_violations) ||
    !findingArray(value.standards.smell_judgement_calls)
  ) {
    return "standards finding lists are invalid";
  }

  if (!isRecord(value.spec)) return "spec must be an object";
  if (
    !findingArray(value.spec.missing_or_partial) ||
    !findingArray(value.spec.incorrect_implementation) ||
    !findingArray(value.spec.scope_creep)
  ) {
    return "spec finding lists are invalid";
  }

  if (!isRecord(value.validation)) return "validation must be an object";
  const commands = value.validation.commands;
  if (
    !Array.isArray(commands) ||
    commands.length === 0 ||
    !commands.every(
      (command) =>
        isRecord(command) &&
        typeof command.command === "string" &&
        command.command.trim().length > 0 &&
        Number.isInteger(command.exit_code) &&
        typeof command.ok === "boolean",
    )
  ) {
    return "validation.commands must contain actual command results";
  }

  if (value.notes !== undefined && typeof value.notes !== "string") {
    return "notes must be a string";
  }
  return null;
}

function findingArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (finding) =>
        isRecord(finding) &&
        typeof finding.summary === "string" &&
        finding.summary.trim().length > 0 &&
        (finding.detail === undefined || typeof finding.detail === "string") &&
        (finding.blocking === undefined ||
          typeof finding.blocking === "boolean"),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fullSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}
