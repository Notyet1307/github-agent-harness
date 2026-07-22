import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HARNESS_ROOT } from "./config.js";

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
  const templatePath = resolve(HARNESS_ROOT, "prompts/implementer.md");
  let text = readFileSync(templatePath, "utf8");
  const map: Record<string, string> = {
    repo: vars.repo,
    issueNumber: String(vars.issueNumber),
    issueUrl: vars.issueUrl,
    baseSha: vars.baseSha,
    branch: vars.branch,
    worktreePath: vars.worktreePath,
    profileId: vars.profileId,
    orcaAgent: vars.orcaAgent,
    invokeHint: vars.invokeHint,
  };
  for (const [k, v] of Object.entries(map)) {
    text = text.replaceAll(`{{${k}}}`, v);
  }
  return text;
}
