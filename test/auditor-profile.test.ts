import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAuditorProfile, loadConfig } from "../src/config.js";
import { findPiAuditorAgentConflicts, runDoctor } from "../src/doctor.js";
import { renderAuditorSpec } from "../src/prompts.js";

test("active auditor uses the controller-owned Pi launcher", () => {
  const profile = getAuditorProfile(loadConfig());

  assert.equal(profile.readonly, true);
  assert.match(profile.command ?? "", /\/scripts\/pi-auditor$/);
  assert.match(profile.invokeHint, /matt-code-review-pi/);
  assert.match(
    readFileSync(join(process.cwd(), "scripts/pi-auditor"), "utf8"),
    /reviewer_child=.*pi-reviewer-child[\s\S]*export PI_SUBAGENT_PI_BINARY="\$reviewer_child"/,
  );
});

test("doctor checks the auditor titlebar extension", (t) => {
  const root = mkdtempSync(join(tmpdir(), "harness-titlebar-doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const piAgentDir = join(root, "pi-agent");
  const configPath = join(root, "harness.yaml");
  mkdirSync(join(piAgentDir, "extensions"), { recursive: true });
  writeFileSync(join(piAgentDir, "extensions/orca-prefill.ts"), "");
  writeFileSync(join(piAgentDir, "extensions/orca-agent-status.ts"), "");
  writeFileSync(
    configPath,
    "version: 1\nissueLabel: ready-for-agent\nrepositories: []\n",
  );

  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  t.after(() => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  });

  const report = runDoctor(configPath);
  const check = report.checks.find(
    (candidate) => candidate.name === "pi-auditor-extension:orca-titlebar",
  );
  assert.equal(check?.level, "fail");
  assert.match(check?.detail ?? "", /orca-titlebar-spinner\.ts/);
});

test("auditor dispatch requires the controller-owned user-scope reviewer", () => {
  const spec = renderAuditorSpec({
    repo: "owner/repo",
    issueNumber: 7,
    issueUrl: "https://example.test/issues/7",
    baseSha: "base-sha",
    headSha: "head-sha",
    branch: "issue-7",
    worktreePath: "/tmp/issue-7",
    profileId: "pi-reviewer",
    orcaAgent: "pi",
    invokeHint: "Invoke the audit skill.",
    auditRound: 1,
    resultPath: "/tmp/issue-7/.harness/audit-result.json",
  });

  assert.match(spec, /agentScope: user/);
  assert.match(spec, /harness-reviewer/);
  assert.doesNotMatch(spec, /agentScope: project/);
  assert.doesNotMatch(spec, /confirmProjectAgents/);
});

test("auditor validation satisfies documented service prerequisites first", () => {
  const spec = renderAuditorSpec({
    repo: "owner/repo",
    issueNumber: 7,
    issueUrl: "https://example.test/issues/7",
    baseSha: "base-sha",
    headSha: "head-sha",
    branch: "issue-7",
    worktreePath: "/tmp/issue-7",
    profileId: "pi-reviewer",
    orcaAgent: "pi",
    invokeHint: "Invoke the audit skill.",
    auditRound: 1,
    resultPath: "/tmp/issue-7/.harness/audit-result.json",
  });

  assert.match(spec, /documented service prerequisites/i);
  assert.match(spec, /unstarted documented prerequisite/i);
  assert.match(spec, /current worktree/i);
});

test("auditor contract requires finding objects instead of bare strings", () => {
  const spec = renderAuditorSpec({
    repo: "owner/repo",
    issueNumber: 7,
    issueUrl: "https://example.test/issues/7",
    baseSha: "base-sha",
    headSha: "head-sha",
    branch: "issue-7",
    worktreePath: "/tmp/issue-7",
    profileId: "pi-reviewer",
    orcaAgent: "pi",
    invokeHint: "Invoke the audit skill.",
    auditRound: 1,
    resultPath: "/tmp/issue-7/.harness/audit-result.json",
  });
  const skill = readFileSync(
    join(process.cwd(), "pi/auditor/skills/matt-code-review-pi/SKILL.md"),
    "utf8",
  );

  for (const contract of [spec, skill]) {
    assert.match(contract, /bare strings? (?:are|is) invalid/i);
    assert.match(contract, /"summary"\s*:/);
    assert.match(contract, /"blocking"\s*:/);
  }
});

test("auditor contract classifies retryable reviewer infrastructure uncertainty", () => {
  const spec = renderAuditorSpec({
    repo: "owner/repo",
    issueNumber: 7,
    issueUrl: "https://example.test/issues/7",
    baseSha: "base-sha",
    headSha: "head-sha",
    branch: "issue-7",
    worktreePath: "/tmp/issue-7",
    profileId: "pi-reviewer",
    orcaAgent: "pi",
    invokeHint: "Invoke the audit skill.",
    auditRound: 1,
    resultPath: "/tmp/issue-7/.harness/audit-result.json",
  });
  const skill = readFileSync(
    join(process.cwd(), "pi/auditor/skills/matt-code-review-pi/SKILL.md"),
    "utf8",
  );

  for (const contract of [spec, skill]) {
    assert.match(contract, /uncertain_reason/);
    assert.match(contract, /reviewer_infrastructure/);
    assert.match(contract, /never merge|never permits a merge/i);
  }
});

test("auditor subagents do not write debug artifacts into the business worktree", () => {
  const skill = readFileSync(
    join(
      process.cwd(),
      "pi/auditor/skills/matt-code-review-pi/SKILL.md",
    ),
    "utf8",
  );

  assert.match(
    skill,
    /subagent\(\{[\s\S]*?artifacts:\s*false,[\s\S]*?tasks:\s*\[/,
  );
});

test("doctor finds user agents that can shadow the controller reviewer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "harness-pi-auditor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const piAgentDir = join(root, "pi-agent");
  const oldAgent = join(piAgentDir, "agents", "custom.md");
  const homeDir = join(root, "home");
  const newAgent = join(homeDir, ".agents", "nested", "reviewer.md");
  const ignoredSkill = join(homeDir, ".agents", "skills", "reviewer.md");
  for (const path of [oldAgent, newAgent, ignoredSkill]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      "---\nname: harness-reviewer\ndescription: conflict\n---\n",
    );
  }

  assert.deepEqual(
    findPiAuditorAgentConflicts(piAgentDir, homeDir),
    [oldAgent, newAgent],
  );
});
