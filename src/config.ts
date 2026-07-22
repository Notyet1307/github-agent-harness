import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { AgentProfile, HarnessConfig, RepoConfig } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = resolve(here, "..");

export function defaultConfigPath(): string {
  return resolve(HARNESS_ROOT, "config/harness.yaml");
}

export function defaultLedgerPath(): string {
  return resolve(HARNESS_ROOT, "data/harness.sqlite");
}

export function defaultLockPath(): string {
  return resolve(HARNESS_ROOT, "data/harness.lock");
}

export function loadConfig(path = defaultConfigPath()): HarnessConfig {
  const raw = readFileSync(path, "utf8");
  const data = parseYaml(raw) as HarnessConfig;

  if (!data || typeof data !== "object") {
    throw new Error(`Invalid config: ${path}`);
  }
  if (!Array.isArray(data.repositories) || data.repositories.length === 0) {
    throw new Error("config.repositories must be a non-empty array");
  }
  if (!data.issueLabel) {
    throw new Error("config.issueLabel is required");
  }

  data.repositories = data.repositories.map(normalizeRepo);
  data.orca = {
    cliPath: data.orca?.cliPath ?? "orca",
    cliPathFallback:
      data.orca?.cliPathFallback ??
      "/Applications/Orca.app/Contents/Resources/bin/orca",
    controllerWorktreePath:
      data.orca?.controllerWorktreePath ?? HARNESS_ROOT,
    controllerTitle: data.orca?.controllerTitle ?? "harness-controller",
  };
  data.implementTimeoutMinutes = data.implementTimeoutMinutes ?? 45;
  data.maxAuditRounds = data.maxAuditRounds ?? 3;
  data.maxConcurrentTotal = data.maxConcurrentTotal ?? 1;
  data.pollIntervalSeconds = data.pollIntervalSeconds ?? 120;
  data.mergePolicy = data.mergePolicy ?? { mode: "wait", autoMerge: false };

  data.agentProfiles = normalizeProfiles(data.agentProfiles);
  data.activeProfiles = data.activeProfiles ?? {
    implementer: "codex-default",
    auditor: "pi-reviewer",
  };

  if (!data.agentProfiles[data.activeProfiles.implementer]) {
    throw new Error(
      `activeProfiles.implementer '${data.activeProfiles.implementer}' not in agentProfiles`,
    );
  }
  if (!data.agentProfiles[data.activeProfiles.auditor]) {
    throw new Error(
      `activeProfiles.auditor '${data.activeProfiles.auditor}' not in agentProfiles`,
    );
  }

  return data;
}

function normalizeRepo(repo: RepoConfig): RepoConfig {
  if (!repo.github || !repo.localPath || !repo.orcaRepoId || !repo.baseRef) {
    throw new Error(
      `repository entry missing required fields: ${JSON.stringify(repo)}`,
    );
  }
  return {
    ...repo,
    localPath: isAbsolute(repo.localPath)
      ? repo.localPath
      : resolve(HARNESS_ROOT, repo.localPath),
    defaultBranch: repo.defaultBranch || "main",
  };
}

function normalizeProfiles(
  profiles: Record<string, AgentProfile> | undefined,
): Record<string, AgentProfile> {
  if (!profiles || Object.keys(profiles).length === 0) {
    return {
      "codex-default": {
        id: "codex-default",
        role: "implementer",
        runtime: "orca",
        orcaAgent: "codex",
        invokeHint: "Explicitly invoke the $implement skill.",
      },
      "pi-reviewer": {
        id: "pi-reviewer",
        role: "auditor",
        runtime: "orca",
        orcaAgent: "pi",
        readonly: true,
        invokeHint: "Explicitly invoke /skill:matt-code-review-pi with the fixed base SHA.",
      },
    };
  }
  for (const [id, p] of Object.entries(profiles)) {
    if (!p.role || !p.orcaAgent || !p.invokeHint) {
      throw new Error(`agentProfiles.${id} missing role/orcaAgent/invokeHint`);
    }
    p.id = p.id ?? id;
    p.runtime = p.runtime ?? "orca";
  }
  return profiles;
}

export function getImplementerProfile(config: HarnessConfig): AgentProfile {
  return config.agentProfiles[config.activeProfiles.implementer]!;
}

export function getAuditorProfile(config: HarnessConfig): AgentProfile {
  return config.agentProfiles[config.activeProfiles.auditor]!;
}
