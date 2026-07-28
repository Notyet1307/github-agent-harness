import {
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isSeq, parse as parseYaml, parseDocument } from "yaml";
import type {
  AgentProfile,
  HarnessConfig,
  MergePolicy,
  ProjectConfig,
} from "./types.js";

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

export function writeRepoConfig(configPath: string, repo: ProjectConfig): void {
  const source = readFileSync(configPath, "utf8");
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join("; "));
  }

  let repositories = document.get("repositories", true);
  if (repositories == null) {
    document.set("repositories", []);
    repositories = document.get("repositories", true);
  }
  if (!isSeq(repositories)) {
    throw new Error("config.repositories must be a YAML sequence");
  }

  const key = repo.github.toLowerCase();
  const existing = repositories.items.find((candidate) => {
    if (!isMap(candidate)) return false;
    const github = candidate.get("github");
    return typeof github === "string" && github.toLowerCase() === key;
  });
  const portable = {
    github: repo.github,
    baseRef: repo.baseRef,
    defaultBranch: repo.defaultBranch,
  };
  if (isMap(existing)) {
    existing.delete("localPath");
    existing.delete("orcaRepoId");
    for (const [field, value] of Object.entries(portable)) {
      existing.set(field, value);
    }
  } else {
    repositories.add(portable);
  }

  const tempPath = join(
    dirname(configPath),
    `.${process.pid}-${Date.now()}-${configPath.split("/").pop() ?? "harness.yaml"}.tmp`,
  );
  const mode = statSync(configPath).mode & 0o777;
  try {
    writeFileSync(tempPath, document.toString(), { mode });
    renameSync(tempPath, configPath);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best effort; preserve the original config write error.
    }
    throw err;
  }
}

export function repoConfigNeedsWrite(
  configPath: string,
  repo: ProjectConfig,
): boolean {
  const parsed = parseYaml(readFileSync(configPath, "utf8")) as {
    repositories?: Array<Record<string, unknown>>;
  };
  const existing = parsed.repositories?.find(
    (candidate) =>
      typeof candidate.github === "string" &&
      candidate.github.toLowerCase() === repo.github.toLowerCase(),
  );
  return (
    !existing ||
    existing.github !== repo.github ||
    existing.baseRef !== repo.baseRef ||
    existing.defaultBranch !== repo.defaultBranch ||
    "localPath" in existing ||
    "orcaRepoId" in existing
  );
}

export function loadConfig(path = defaultConfigPath()): HarnessConfig {
  const raw = readFileSync(path, "utf8");
  const data = parseYaml(raw) as HarnessConfig;

  if (!data || typeof data !== "object") {
    throw new Error(`Invalid config: ${path}`);
  }
  if (!Array.isArray(data.repositories)) {
    throw new Error("config.repositories must be an array");
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
    controllerTitle: data.orca?.controllerTitle ?? "harness-controller",
  };
  data.implementTimeoutMinutes = data.implementTimeoutMinutes ?? 45;
  data.auditTimeoutMinutes = data.auditTimeoutMinutes ?? 45;
  data.maxAuditRounds = data.maxAuditRounds ?? 3;
  data.maxConcurrentTotal = data.maxConcurrentTotal ?? 1;
  data.pollIntervalSeconds = data.pollIntervalSeconds ?? 120;
  data.mergePolicy = normalizeMergePolicy(data.mergePolicy);

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


function normalizeRepo(repo: ProjectConfig): ProjectConfig {
  if (!repo.github || !repo.baseRef) {
    throw new Error(
      `repository entry missing required fields: ${JSON.stringify(repo)}`,
    );
  }
  return {
    github: repo.github,
    baseRef: repo.baseRef,
    defaultBranch: repo.defaultBranch || "main",
  };
}

function normalizeMergePolicy(raw: unknown): MergePolicy {
  if (raw === undefined) return { mode: "wait", autoMerge: false };
  if (!raw || typeof raw !== "object") {
    throw new Error("mergePolicy must be { mode: wait, autoMerge: false } or { mode: auto, autoMerge: true }");
  }
  const policy = raw as { mode?: unknown; autoMerge?: unknown };
  if (policy.mode === "wait" && policy.autoMerge === false) {
    return { mode: "wait", autoMerge: false };
  }
  if (policy.mode === "auto" && policy.autoMerge === true) {
    return { mode: "auto", autoMerge: true };
  }
  throw new Error(
    "mergePolicy must be { mode: wait, autoMerge: false } or { mode: auto, autoMerge: true }",
  );
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
    if (p.command && !isAbsolute(p.command)) {
      p.command = resolve(HARNESS_ROOT, p.command);
    }
  }
  return profiles;
}

export function getImplementerProfile(config: HarnessConfig): AgentProfile {
  return config.agentProfiles[config.activeProfiles.implementer]!;
}

export function getAuditorProfile(config: HarnessConfig): AgentProfile {
  return config.agentProfiles[config.activeProfiles.auditor]!;
}
