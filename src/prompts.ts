import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HARNESS_ROOT } from "./config.js";

function renderTemplate(
  relativePath: string,
  map: Record<string, string>,
): string {
  let text = readFileSync(resolve(HARNESS_ROOT, relativePath), "utf8");
  for (const [k, v] of Object.entries(map)) {
    text = text.replaceAll(`{{${k}}}`, v);
  }
  return text;
}

export function renderImplementerSpec(vars: {
  repo: string;
  issueNumber: number;
  issueUrl: string;
  baseSha: string;
  branch: string;
  worktreePath: string;
  profileId: string;
  orcaAgent: string;
  invokeHint: string;
}): string {
  return renderTemplate("prompts/implementer.md", {
    repo: vars.repo,
    issueNumber: String(vars.issueNumber),
    issueUrl: vars.issueUrl,
    baseSha: vars.baseSha,
    branch: vars.branch,
    worktreePath: vars.worktreePath,
    profileId: vars.profileId,
    orcaAgent: vars.orcaAgent,
    invokeHint: vars.invokeHint,
  });
}

export function renderAuditorSpec(vars: {
  repo: string;
  issueNumber: number;
  issueUrl: string;
  baseSha: string;
  headSha: string;
  branch: string;
  worktreePath: string;
  profileId: string;
  orcaAgent: string;
  invokeHint: string;
  auditRound: number;
  resultPath: string;
}): string {
  return renderTemplate("prompts/auditor.md", {
    repo: vars.repo,
    issueNumber: String(vars.issueNumber),
    issueUrl: vars.issueUrl,
    baseSha: vars.baseSha,
    headSha: vars.headSha,
    branch: vars.branch,
    worktreePath: vars.worktreePath,
    profileId: vars.profileId,
    orcaAgent: vars.orcaAgent,
    invokeHint: vars.invokeHint,
    auditRound: String(vars.auditRound),
    resultPath: vars.resultPath,
  });
}

export function renderReworkSpec(vars: {
  repo: string;
  issueNumber: number;
  issueUrl: string;
  baseSha: string;
  branch: string;
  worktreePath: string;
  profileId: string;
  invokeHint: string;
  auditRound: number;
  auditResultJson: string;
}): string {
  return renderTemplate("prompts/rework.md", {
    repo: vars.repo,
    issueNumber: String(vars.issueNumber),
    issueUrl: vars.issueUrl,
    baseSha: vars.baseSha,
    branch: vars.branch,
    worktreePath: vars.worktreePath,
    profileId: vars.profileId,
    invokeHint: vars.invokeHint,
    auditRound: String(vars.auditRound),
    auditResultJson: vars.auditResultJson,
  });
}
