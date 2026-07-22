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
    const raw = JSON.parse(readFileSync(path, "utf8")) as AuditResult;
    return { ok: true, result: raw };
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

  if (statusFail || computedFail) {
    return {
      pass: false,
      reason: `blocking findings standards=${blockingStandards} spec=${blockingSpec} validation=${validationFailures}`,
      result,
      blockingStandards,
      blockingSpec,
      validationFailures,
      uncertain: false,
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

/** Tracked working tree dirty? Untracked files (e.g. .pi, .harness) ignored. */
export function trackedDirty(worktreePath: string): string {
  const r = execFile("git", [
    "-C",
    worktreePath,
    "status",
    "--porcelain",
    "-uno",
  ]);
  return r.ok ? r.stdout.trim() : r.stderr.trim();
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
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
}
