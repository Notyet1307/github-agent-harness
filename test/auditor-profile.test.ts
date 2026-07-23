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
import { findPiAuditorAgentConflicts } from "../src/doctor.js";
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
