import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateAuditGate,
  inspectAuditArtifact,
  loadAuditResult,
  trackedDirty,
} from "../src/audit-gate.js";
import type { AuditResult } from "../src/types.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function validAuditResult(): AuditResult {
  return {
    status: "pass",
    base_sha: baseSha,
    head_sha: headSha,
    standards: {
      documented_standard_violations: [],
      smell_judgement_calls: [],
    },
    spec: {
      missing_or_partial: [],
      incorrect_implementation: [],
      scope_creep: [],
    },
    validation: {
      commands: [{ command: "npm test", exit_code: 0, ok: true }],
    },
  };
}

test("loadAuditResult rejects an incomplete pass result", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "audit-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "audit-result.json");
  writeFileSync(path, JSON.stringify({ status: "pass" }));

  const loaded = loadAuditResult(path);

  assert.equal(loaded.ok, false);
  assert.match(loaded.error ?? "", /invalid audit result/);
});

test("loadAuditResult requires full SHAs and actual validation evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "audit-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "audit-result.json");
  const invalidCases: Array<(result: AuditResult) => void> = [
    (result) => {
      result.base_sha = "a";
    },
    (result) => {
      result.head_sha = "b";
    },
    (result) => {
      result.validation.commands = [];
    },
    (result) => {
      result.validation.commands[0]!.command = " ";
    },
    (result) => {
      result.standards.documented_standard_violations = [{ summary: " " }];
    },
    (result) => {
      result.standards.documented_standard_violations = [
        "bare violation" as never,
      ];
    },
  ];

  for (const invalidate of invalidCases) {
    const result = validAuditResult();
    invalidate(result);
    writeFileSync(path, JSON.stringify(result));
    const loaded = loadAuditResult(path);
    assert.equal(loaded.ok, false);
    assert.match(loaded.error ?? "", /invalid audit result/);
  }
});

test("inspectAuditArtifact distinguishes malformed, stale, and current results", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "audit-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "audit-result.json");

  assert.equal(
    inspectAuditArtifact(path, baseSha, headSha).status,
    "missing",
  );

  const malformed = validAuditResult();
  malformed.standards.documented_standard_violations = [
    "bare violation" as never,
  ];
  writeFileSync(path, JSON.stringify(malformed));
  assert.equal(
    inspectAuditArtifact(path, baseSha, headSha).status,
    "malformed",
  );

  const stale = validAuditResult();
  stale.head_sha = "c".repeat(40);
  writeFileSync(path, JSON.stringify(stale));
  assert.equal(inspectAuditArtifact(path, baseSha, headSha).status, "stale");

  writeFileSync(path, JSON.stringify(validAuditResult()));
  assert.equal(
    inspectAuditArtifact(path, baseSha, headSha).status,
    "current",
  );
});

test("evaluateAuditGate accepts a complete result for the exact SHAs", () => {
  const result = validAuditResult();
  const gate = evaluateAuditGate(result, {
    expectedBaseSha: baseSha,
    expectedHeadSha: headSha,
  });

  assert.equal(gate.pass, true, gate.reason);
});

test("evaluateAuditGate treats a fail without actionable evidence as uncertain", () => {
  const result = validAuditResult();
  result.status = "fail";

  const gate = evaluateAuditGate(result, {
    expectedBaseSha: baseSha,
    expectedHeadSha: headSha,
  });

  assert.equal(gate.pass, false);
  assert.equal(gate.uncertain, true);
});

test("trackedDirty fails closed when git cannot run", () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.match(trackedDirty("/unused"), /git status failed/i);
  } finally {
    process.env.PATH = originalPath;
  }
});
