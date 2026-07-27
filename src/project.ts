import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { loadConfig, writeRepoConfig } from "./config.js";
import { execFile } from "./exec.js";
import { git } from "./git.js";
import { orcaJson, requireOrcaCli, unwrapResult } from "./orca.js";
import type { EnrolledProject, ProjectSnapshot, RepoConfig } from "./types.js";
export type { EnrolledProject } from "./types.js";

export type ProjectCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type EnrollmentAction = {
  kind: "register_orca" | "set_orca_base_ref" | "write_config";
  applied: boolean;
};

export type AddProjectInput = {
  configPath: string;
  github: string;
  localPath: string;
  defaultBranch?: string;
  baseRef?: string;
  dryRun?: boolean;
};

export type SetupProjectsInput = {
  configPath: string;
  github?: string;
  dryRun?: boolean;
};

export type SetupReport = {
  ok: boolean;
  message: string;
  results: EnrollmentResult[];
};

export type EnrollmentResult = {
  ok: boolean;
  status: "planned" | "created" | "unchanged" | "repaired" | "failed";
  message: string;
  project?: EnrolledProject;
  checks: ProjectCheck[];
  actions: EnrollmentAction[];
};

type OrcaRepo = {
  id: string;
  path: string;
  worktreeBaseRef?: string;
  gitRemoteIdentity?: {
    canonicalKey?: string;
  };
};

export function createProjectSnapshot(repo: RepoConfig): {
  snapshot: ProjectSnapshot;
  revision: string;
  json: string;
} {
  const key = normalizeProjectKey(repo.github);
  const snapshot: ProjectSnapshot = {
    version: 1,
    key,
    github: key,
    localPath: repo.localPath,
    baseRef: repo.baseRef,
    defaultBranch: repo.defaultBranch,
    orcaRepoId: repo.orcaRepoId,
  };
  const json = JSON.stringify(snapshot);
  return {
    snapshot,
    revision: createHash("sha256").update(json).digest("hex"),
    json,
  };
}

export function parseProjectSnapshot(
  json: string,
):
  | { ok: true; snapshot: ProjectSnapshot; revision: string }
  | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: "project snapshot is not valid JSON" };
  }
  if (!isProjectSnapshot(value)) {
    return { ok: false, error: "project snapshot has an invalid shape" };
  }
  if (value.github !== value.key || normalizeProjectKey(value.github) !== value.key) {
    return { ok: false, error: "project snapshot identity is not canonical" };
  }
  return {
    ok: true,
    snapshot: value,
    revision: createHash("sha256").update(json).digest("hex"),
  };
}

export function projectConfigFromSnapshot(
  snapshot: ProjectSnapshot,
): RepoConfig {
  return {
    github: snapshot.github,
    localPath: snapshot.localPath,
    baseRef: snapshot.baseRef,
    defaultBranch: snapshot.defaultBranch,
    orcaRepoId: snapshot.orcaRepoId,
  };
}

export function validateProjectRuntime(
  project: RepoConfig,
  orcaCli: string,
): { ok: true } | { ok: false; error: string } {
  const topLevel = git(project.localPath, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) {
    return {
      ok: false,
      error: `project path is not a readable Git worktree: ${project.localPath}`,
    };
  }
  const localPath = realpathOrOriginal(project.localPath);
  if (realpathOrOriginal(topLevel.stdout) !== localPath) {
    return {
      ok: false,
      error: `project path is not the Git root: ${project.localPath}`,
    };
  }

  const remote = readRemote(localPath, "origin");
  const key = normalizeProjectKey(project.github);
  if (!remote || canonicalGithubKey(remote.url) !== key) {
    return {
      ok: false,
      error: `project origin does not match snapshot identity ${key}`,
    };
  }
  if (remote.pushUrls.some((url) => canonicalGithubKey(url) !== key)) {
    return {
      ok: false,
      error: `project origin push URL does not match snapshot identity ${key}`,
    };
  }

  const shown = orcaJson(orcaCli, [
    "repo",
    "show",
    "--repo",
    `id:${project.orcaRepoId}`,
  ]);
  const orcaRepo = shown.ok ? parseAddedOrcaRepo(shown.data) : null;
  if (!shown.ok || !orcaRepo) {
    return {
      ok: false,
      error: `cannot verify snapshot Orca repo ${project.orcaRepoId}: ${shown.error ?? "invalid response"}`,
    };
  }
  if (orcaRepo.id !== project.orcaRepoId) {
    return {
      ok: false,
      error: `snapshot Orca repo id ${project.orcaRepoId} resolved as ${orcaRepo.id}`,
    };
  }
  if (realpathOrOriginal(orcaRepo.path) !== localPath) {
    return {
      ok: false,
      error: `snapshot Orca repo path ${orcaRepo.path} does not match ${localPath}`,
    };
  }
  if (orcaRepo.worktreeBaseRef !== project.baseRef) {
    return {
      ok: false,
      error: `snapshot Orca base ref ${orcaRepo.worktreeBaseRef ?? "(missing)"} does not match ${project.baseRef}`,
    };
  }
  const identity = orcaRepo.gitRemoteIdentity?.canonicalKey;
  if (!identity || normalizeProjectKey(identity) !== key) {
    return {
      ok: false,
      error: `snapshot Orca repo identity ${identity ?? "(missing)"} does not match ${key}`,
    };
  }
  return { ok: true };
}

function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return (
    snapshot.version === 1 &&
    typeof snapshot.key === "string" &&
    typeof snapshot.github === "string" &&
    typeof snapshot.localPath === "string" &&
    isAbsolute(snapshot.localPath) &&
    typeof snapshot.baseRef === "string" &&
    snapshot.baseRef.length > 0 &&
    typeof snapshot.defaultBranch === "string" &&
    snapshot.defaultBranch.length > 0 &&
    typeof snapshot.orcaRepoId === "string" &&
    snapshot.orcaRepoId.length > 0
  );
}

export function setupProjects(input: SetupProjectsInput): SetupReport {
  let config;
  try {
    config = loadConfig(input.configPath);
  } catch (err) {
    return { ok: false, message: (err as Error).message, results: [] };
  }

  const key = input.github ? normalizeProjectKey(input.github) : null;
  const repositories = key
    ? config.repositories.filter(
        (repo) => normalizeProjectKey(repo.github) === key,
      )
    : config.repositories;
  if (key && repositories.length === 0) {
    return {
      ok: false,
      message: `project not in config: ${input.github}`,
      results: [],
    };
  }

  const results = repositories.map((repo) =>
    addProject({
      configPath: input.configPath,
      github: repo.github,
      localPath: repo.localPath,
      defaultBranch: repo.defaultBranch,
      baseRef: repo.baseRef,
      dryRun: input.dryRun,
    }),
  );
  return {
    ok: results.every((result) => result.ok),
    message:
      repositories.length === 0
        ? "no projects configured"
        : `checked ${repositories.length} project${repositories.length === 1 ? "" : "s"}`,
    results,
  };
}

export function addProject(input: AddProjectInput): EnrollmentResult {
  const planned = planProjectAdd(input);
  if (!planned.ok || input.dryRun || planned.status === "unchanged") {
    return planned;
  }
  if (!planned.project) {
    return failed("enrollment plan is missing project details", planned.checks, planned.actions);
  }

  const config = loadConfig(input.configPath);
  const existed = config.repositories.some(
    (repo) => normalizeProjectKey(repo.github) === planned.project!.key,
  );
  const actions = planned.actions.map((action) => ({ ...action }));
  const project = { ...planned.project };
  const orcaCli = requireOrcaCli(config);

  for (const action of actions) {
    if (action.kind === "register_orca") {
      const added = orcaJson(orcaCli, [
        "repo",
        "add",
        "--path",
        project.localPath,
      ]);
      const addedRepo = added.ok ? parseAddedOrcaRepo(added.data) : null;
      if (!added.ok || !addedRepo?.id) {
        return {
          ok: false,
          status: "failed",
          message: `orca repo add failed: ${added.error ?? "invalid response"}`,
          project,
          checks: planned.checks,
          actions,
        };
      }
      project.orcaRepoId = addedRepo.id;
      const verified = verifyAddedOrcaRepo(
        orcaCli,
        addedRepo,
        project.localPath,
        project.github,
      );
      if (!verified.ok) {
        return {
          ok: false,
          status: "failed",
          message: verified.error,
          project,
          checks: planned.checks,
          actions,
        };
      }
      action.applied = true;
      continue;
    }

    if (action.kind === "set_orca_base_ref") {
      if (!project.orcaRepoId) {
        return {
          ok: false,
          status: "failed",
          message: "cannot set Orca base ref without a repo id",
          project,
          checks: planned.checks,
          actions,
        };
      }
      const updated = orcaJson(orcaCli, [
        "repo",
        "set-base-ref",
        "--repo",
        `id:${project.orcaRepoId}`,
        "--ref",
        project.baseRef,
      ]);
      if (!updated.ok) {
        return {
          ok: false,
          status: "failed",
          message: `orca repo set-base-ref failed: ${updated.error ?? "unknown error"}`,
          project,
          checks: planned.checks,
          actions,
        };
      }
      action.applied = true;
      continue;
    }

    if (!project.orcaRepoId) {
      return {
        ok: false,
        status: "failed",
        message: "cannot write project config without an Orca repo id",
        project,
        checks: planned.checks,
        actions,
      };
    }
    try {
      writeRepoConfig(input.configPath, {
        github: project.github,
        localPath: project.localPath,
        orcaRepoId: project.orcaRepoId,
        baseRef: project.baseRef,
        defaultBranch: project.defaultBranch,
      });
      action.applied = true;
    } catch (err) {
      return {
        ok: false,
        status: "failed",
        message: `config write failed after Orca enrollment: ${(err as Error).message}`,
        project,
        checks: planned.checks,
        actions,
      };
    }
  }

  return {
    ok: true,
    status: existed ? "repaired" : "created",
    message: `project ${project.github} ${existed ? "repaired" : "enrolled"}`,
    project,
    checks: planned.checks,
    actions,
  };
}

export function planProjectAdd(input: AddProjectInput): EnrollmentResult {
  const checks: ProjectCheck[] = [];
  const actions: EnrollmentAction[] = [];

  if (!isAbsolute(input.localPath)) {
    return failed("project path must be absolute", checks, actions);
  }

  let localPath: string;
  try {
    localPath = realpathSync(input.localPath);
  } catch (err) {
    return failed(`project path is not readable: ${(err as Error).message}`, checks, actions);
  }

  const inside = git(localPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") {
    return failed("project path is not a Git worktree", checks, actions);
  }
  const topLevel = git(localPath, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) {
    return failed("cannot resolve project Git root", checks, actions);
  }
  try {
    localPath = realpathSync(topLevel.stdout);
  } catch (err) {
    return failed(`project Git root is not readable: ${(err as Error).message}`, checks, actions);
  }
  checks.push({ name: "git-worktree", ok: true, detail: localPath });

  const github = normalizeGithubSlug(input.github);
  if (!github) {
    return failed(`invalid GitHub repository: ${input.github}`, checks, actions);
  }

  const remote = readRemote(localPath, "origin");
  if (!remote || canonicalGithubKey(remote.url) !== github.key) {
    return failed(
      `origin remote does not match ${github.display}`,
      checks,
      actions,
    );
  }
  if (
    remote.pushUrls.length === 0 ||
    remote.pushUrls.some((pushUrl) => canonicalGithubKey(pushUrl) !== github.key)
  ) {
    return failed(
      `origin push URL does not match ${github.display}`,
      checks,
      actions,
    );
  }
  checks.push({
    name: "git-remote",
    ok: true,
    detail: `${remote.name}=${remote.url}`,
  });

  const defaultBranch =
    input.defaultBranch ?? discoverDefaultBranch(github.display);
  if (!defaultBranch) {
    return failed(
      `cannot determine default branch for ${github.display}`,
      checks,
      actions,
    );
  }
  if (!githubBranchExists(github.display, defaultBranch)) {
    return failed(
      `default branch does not exist on GitHub: ${defaultBranch}`,
      checks,
      actions,
    );
  }
  checks.push({
    name: "default-branch",
    ok: true,
    detail: defaultBranch,
  });

  const baseRef = input.baseRef ?? `${remote.name}/${defaultBranch}`;
  const slash = baseRef.indexOf("/");
  const baseRemote = slash > 0 ? baseRef.slice(0, slash) : "";
  if (baseRemote !== "origin") {
    return failed(
      `baseRef must use origin: ${baseRef}`,
      checks,
      actions,
    );
  }
  const baseBranch = baseRef.slice(slash + 1);
  if (
    baseBranch !== defaultBranch &&
    !githubBranchExists(github.display, baseBranch)
  ) {
    return failed(
      `base branch does not exist on GitHub: ${baseBranch}`,
      checks,
      actions,
    );
  }
  checks.push({ name: "base-ref", ok: true, detail: baseRef });

  let config;
  try {
    config = loadConfig(input.configPath);
  } catch (err) {
    return failed((err as Error).message, checks, actions);
  }

  const sameKey = config.repositories.find(
    (repo) => normalizeProjectKey(repo.github) === github.key,
  );
  if (sameKey && projectRootOrOriginal(sameKey.localPath) !== localPath) {
    return failed(
      `project ${sameKey.github} is already bound to ${sameKey.localPath}`,
      checks,
      actions,
    );
  }
  const samePath = config.repositories.find(
    (repo) => projectRootOrOriginal(repo.localPath) === localPath,
  );
  if (samePath && normalizeProjectKey(samePath.github) !== github.key) {
    return failed(
      `path ${localPath} is already bound to ${samePath.github}`,
      checks,
      actions,
    );
  }

  let orcaCli: string;
  try {
    orcaCli = requireOrcaCli(config);
  } catch (err) {
    return failed((err as Error).message, checks, actions);
  }
  const listed = orcaJson(orcaCli, ["repo", "list"]);
  if (!listed.ok) {
    return failed(
      `orca repo list failed: ${listed.error ?? "unknown error"}`,
      checks,
      actions,
    );
  }
  const repos = parseOrcaRepos(listed.data);
  if (!repos) {
    return failed("invalid Orca repo list response", checks, actions);
  }
  const matches = repos.filter(
    (repo) => realpathOrOriginal(repo.path) === localPath,
  );
  if (matches.length > 1) {
    return failed(`multiple Orca repos are bound to ${localPath}`, checks, actions);
  }
  const orcaRepo = matches[0];
  const orcaIdentity = orcaRepo?.gitRemoteIdentity?.canonicalKey;
  if (
    orcaIdentity &&
    normalizeProjectKey(orcaIdentity) !== github.key
  ) {
    return failed(
      `Orca repo identity ${orcaIdentity} does not match ${github.display}`,
      checks,
      actions,
    );
  }
  checks.push({
    name: "orca-repo",
    ok: true,
    detail: orcaRepo ? `id=${orcaRepo.id}` : "registration required",
  });

  const project: EnrolledProject = {
    key: github.key,
    github: github.display,
    defaultBranch,
    localPath,
    baseRef,
    orcaRepoId: orcaRepo?.id ?? null,
  };

  if (!orcaRepo) {
    actions.push({ kind: "register_orca", applied: false });
    actions.push({ kind: "set_orca_base_ref", applied: false });
  } else if (orcaRepo.worktreeBaseRef !== baseRef) {
    actions.push({ kind: "set_orca_base_ref", applied: false });
  }

  const configMatches =
    sameKey &&
    sameKey.localPath === localPath &&
    sameKey.defaultBranch === defaultBranch &&
    sameKey.baseRef === baseRef &&
    sameKey.orcaRepoId === orcaRepo?.id;
  if (!configMatches) {
    actions.push({ kind: "write_config", applied: false });
  }

  return {
    ok: true,
    status: actions.length === 0 ? "unchanged" : "planned",
    message:
      actions.length === 0
        ? `project ${github.display} is already enrolled`
        : `project ${github.display} enrollment planned`,
    project,
    checks,
    actions,
  };
}

function githubBranchExists(github: string, branch: string): boolean {
  const result = execFile("gh", [
    "api",
    `repos/${github}/branches/${encodeURIComponent(branch)}`,
  ]);
  return result.ok;
}

function discoverDefaultBranch(github: string): string | null {
  const result = execFile("gh", [
    "repo",
    "view",
    github,
    "--json",
    "defaultBranchRef",
  ]);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout) as {
      defaultBranchRef?: { name?: string };
    };
    return parsed.defaultBranchRef?.name ?? null;
  } catch {
    return null;
  }
}

function readRemote(
  localPath: string,
  name: string,
): { name: string; url: string; pushUrls: string[] } | null {
  const remote = git(localPath, ["remote", "get-url", name]);
  if (!remote.ok) return null;
  const push = git(localPath, ["remote", "get-url", "--push", "--all", name]);
  if (!push.ok) return null;
  return {
    name,
    url: remote.stdout,
    pushUrls: push.stdout.split(/\r?\n/).filter(Boolean),
  };
}

function normalizeGithubSlug(
  value: string,
): { key: string; display: string } | null {
  const trimmed = value.trim().replace(/^github\.com\//i, "").replace(/\.git$/i, "");
  const parts = trimmed.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) return null;
  return { key: `${parts[0]}/${parts[1]}`.toLowerCase(), display: `${parts[0]}/${parts[1]}` };
}

function normalizeProjectKey(value: string): string {
  return normalizeGithubSlug(value)?.key ?? value.toLowerCase();
}

function canonicalGithubKey(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/i, "");
  const match =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i.exec(trimmed) ??
    /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(trimmed) ??
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i.exec(trimmed);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function parseOrcaRepos(data: unknown): OrcaRepo[] | null {
  const result = unwrapResult<{ repos?: unknown }>(data);
  if (!Array.isArray(result.repos) || !result.repos.every(isOrcaRepo)) {
    return null;
  }
  return result.repos;
}

function isOrcaRepo(value: unknown): value is OrcaRepo {
  if (!value || typeof value !== "object") return false;
  const repo = value as {
    id?: unknown;
    path?: unknown;
    worktreeBaseRef?: unknown;
    gitRemoteIdentity?: unknown;
  };
  if (
    typeof repo.id !== "string" ||
    typeof repo.path !== "string" ||
    (repo.worktreeBaseRef !== undefined &&
      typeof repo.worktreeBaseRef !== "string")
  ) {
    return false;
  }
  if (repo.gitRemoteIdentity === undefined) return true;
  if (!repo.gitRemoteIdentity || typeof repo.gitRemoteIdentity !== "object") {
    return false;
  }
  const canonicalKey = (repo.gitRemoteIdentity as { canonicalKey?: unknown })
    .canonicalKey;
  return canonicalKey === undefined || typeof canonicalKey === "string";
}

function verifyAddedOrcaRepo(
  orcaCli: string,
  added: OrcaRepo,
  localPath: string,
  github: string,
): { ok: true } | { ok: false; error: string } {
  let repo = added;
  if (!repo.gitRemoteIdentity?.canonicalKey) {
    const shown = orcaJson(orcaCli, [
      "repo",
      "show",
      "--repo",
      `id:${added.id}`,
    ]);
    const parsed = shown.ok ? parseAddedOrcaRepo(shown.data) : null;
    if (!shown.ok || !parsed) {
      return {
        ok: false,
        error: `cannot verify new Orca repo ${added.id}: ${shown.error ?? "invalid response"}`,
      };
    }
    repo = parsed;
  }
  if (realpathOrOriginal(repo.path) !== localPath) {
    return {
      ok: false,
      error: `new Orca repo path ${repo.path} does not match ${localPath}`,
    };
  }
  const identity = repo.gitRemoteIdentity?.canonicalKey;
  if (!identity || normalizeProjectKey(identity) !== normalizeProjectKey(github)) {
    return {
      ok: false,
      error: `new Orca repo identity ${identity ?? "(missing)"} does not match ${github}`,
    };
  }
  return { ok: true };
}

function parseAddedOrcaRepo(data: unknown): OrcaRepo | null {
  const result = unwrapResult<{
    repo?: unknown;
    id?: unknown;
    path?: unknown;
  }>(data);
  if (isOrcaRepo(result.repo)) return result.repo;
  if (typeof result.id === "string") {
    return {
      id: result.id,
      path: typeof result.path === "string" ? result.path : "",
    };
  }
  return null;
}

function projectRootOrOriginal(path: string): string {
  const resolved = realpathOrOriginal(path);
  const topLevel = git(resolved, ["rev-parse", "--show-toplevel"]);
  return topLevel.ok ? realpathOrOriginal(topLevel.stdout) : resolved;
}

function realpathOrOriginal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function failed(
  message: string,
  checks: ProjectCheck[],
  actions: EnrollmentAction[],
): EnrollmentResult {
  return { ok: false, status: "failed", message, checks, actions };
}
