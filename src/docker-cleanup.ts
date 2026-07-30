import { execFile, type ExecResult } from "./exec.js";
import type { Job } from "./types.js";
import { TERMINAL_JOB_STATES } from "./types.js";

type DockerInspect = {
  Id?: string;
  Name?: string;
  Config?: { Labels?: Record<string, string> };
};

export type DockerCleanupItem = {
  project: string;
  jobId: string;
  state: Job["state"];
  containers: string[];
  volumes: string[];
  networks: string[];
  executed: boolean;
  ok: boolean;
  message: string;
};

export type DockerCleanupOptions = {
  dryRun: boolean;
  /**
   * Older worktree cleanup erased ledger paths. This opt-in recognizes only
   * Orca's canonical issue worktree label, never arbitrary Compose projects.
   */
  legacy?: boolean;
};

export function cleanupHarnessDocker(
  jobs: Job[],
  options: DockerCleanupOptions,
  run: typeof execFile = execFile,
): DockerCleanupItem[] {
  const { dryRun, legacy = false } = options;
  const terminalByWorktree = new Map(
    jobs
      .filter((job) => TERMINAL_JOB_STATES.has(job.state) && job.worktree_path)
      .map((job) => [job.worktree_path!, job]),
  );
  const activeWorktrees = new Set(
    jobs
      .filter((job) => !TERMINAL_JOB_STATES.has(job.state) && job.worktree_path)
      .map((job) => job.worktree_path!),
  );
  const ids = dockerLines(run("docker", ["ps", "-aq", "--filter", "label=com.docker.compose.project"]));
  if (ids.length === 0) return [];
  const inspected = run("docker", ["inspect", ...ids]);
  if (!inspected.ok) {
    return [{ project: "-", jobId: "-", state: "cancelled", containers: [], volumes: [], networks: [], executed: false, ok: false, message: dockerError(inspected) }];
  }
  const groups = new Map<string, { project: string; worktree: string; job: Job; containers: string[]; legacy: boolean }>();
  for (const container of JSON.parse(inspected.stdout) as DockerInspect[]) {
    const labels = container.Config?.Labels ?? {};
    const project = labels["com.docker.compose.project"];
    const worktree = labels["com.docker.compose.project.working_dir"];
    if (!project || !worktree || activeWorktrees.has(worktree) || matchesActiveLegacyWorktree(jobs, worktree)) continue;
    const exactJob = terminalByWorktree.get(worktree);
    const job = exactJob ?? (legacy ? findLegacyTerminalJob(jobs, worktree) : undefined);
    if (!job) continue;
    const key = `${project}\u0000${worktree}`;
    const group = groups.get(key) ?? { project, worktree, job, containers: [], legacy: !exactJob };
    if (container.Id) group.containers.push(container.Id);
    groups.set(key, group);
  }
  const uniqueProjectGroups = [...groups.values()].filter((group) =>
    [...groups.values()].filter((other) => other.project === group.project).length === 1,
  );
  return uniqueProjectGroups.map((group) => {
    const { project } = group;
    const volumes = dockerLines(run("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]));
    const networks = dockerLines(run("docker", ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]));
    const item: DockerCleanupItem = {
      project, jobId: group.job.id, state: group.job.state,
      containers: group.containers, volumes, networks, executed: !dryRun, ok: true,
      message: dryRun
        ? group.legacy
          ? "remove legacy terminal Compose resources proven by Orca path label and ledger issue"
          : "remove terminal Compose resources proven by labels and ledger"
        : "removed terminal Compose resources",
    };
    if (dryRun) return item;
    const removals = [
      group.containers.length ? run("docker", ["rm", "-f", ...group.containers]) : null,
      networks.length ? run("docker", ["network", "rm", ...networks]) : null,
      volumes.length ? run("docker", ["volume", "rm", ...volumes]) : null,
    ].filter((result): result is ExecResult => result !== null);
    const failed = removals.find((result) => !result.ok);
    return failed ? { ...item, ok: false, message: dockerError(failed) } : item;
  });
}

function findLegacyTerminalJob(jobs: Job[], worktree: string): Job | undefined {
  return jobs.find((job) =>
    TERMINAL_JOB_STATES.has(job.state) && legacyWorktreeMatchesJob(worktree, job),
  );
}

function matchesActiveLegacyWorktree(jobs: Job[], worktree: string): boolean {
  return jobs.some((job) =>
    !TERMINAL_JOB_STATES.has(job.state) && legacyWorktreeMatchesJob(worktree, job),
  );
}

function legacyWorktreeMatchesJob(worktree: string, job: Job): boolean {
  const match = /\/orca\/workspaces\/([^/]+)\/issue-(\d+)\/?$/.exec(worktree);
  const repoName = job.repo.split("/").at(-1);
  return Boolean(
    match && repoName &&
      match[1]!.toLowerCase() === repoName.toLowerCase() &&
      Number(match[2]) === job.issue_number,
  );
}

function dockerLines(result: ExecResult): string[] {
  return result.ok ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function dockerError(result: ExecResult): string {
  return (result.error || result.stderr || `docker exited ${result.code ?? "unknown"}`).trim();
}
