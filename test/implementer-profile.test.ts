import test from "node:test";
import assert from "node:assert/strict";
import {
  renderImplementerSpec,
  renderReworkSpec,
} from "../src/prompts.js";

test("implementation specs keep internal reviewers outside the Orca lifecycle", () => {
  const specs = [
    renderImplementerSpec({
      repo: "owner/repo",
      issueNumber: 10,
      issueUrl: "https://example.test/issues/10",
      baseSha: "base-sha",
      branch: "issue-10",
      worktreePath: "/tmp/issue-10",
      profileId: "codex-default",
      orcaAgent: "codex",
      invokeHint: "Invoke the implement skill.",
    }),
    renderReworkSpec({
      repo: "owner/repo",
      issueNumber: 10,
      issueUrl: "https://example.test/issues/10",
      baseSha: "base-sha",
      branch: "issue-10",
      worktreePath: "/tmp/issue-10",
      profileId: "codex-default",
      invokeHint: "Invoke the implement skill.",
      auditRound: 1,
      auditResultJson: "{}",
    }),
  ];

  for (const spec of specs) {
    assert.match(spec, /fork_turns: "none"/);
    assert.match(spec, /must not receive.*taskId.*dispatchId/is);
    assert.match(
      spec,
      /Only the parent implementer session may send `worker_done`/,
    );
    assert.match(
      spec,
      /after the required internal review, intended commit, and validation are complete/,
    );
  }
});
