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

export function cleanupHarnessDocker(
  jobs: Job[],
  dryRun: boolean,
  run: typeof execFile = execFile,
): DockerCleanupItem[] {
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
  const groups = new Map<string, { job: Job; containers: string[] }>();
  for (const container of JSON.parse(inspected.stdout) as DockerInspect[]) {
    const labels = container.Config?.Labels ?? {};
    const project = labels["com.docker.compose.project"];
    const worktree = labels["com.docker.compose.project.working_dir"];
    if (!project || !worktree || activeWorktrees.has(worktree)) continue;
    const job = terminalByWorktree.get(worktree);
    if (!job) continue;
    const group = groups.get(project) ?? { job, containers: [] };
    if (container.Id) group.containers.push(container.Id);
    groups.set(project, group);
  }
  return [...groups].map(([project, group]) => {
    const volumes = dockerLines(run("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]));
    const networks = dockerLines(run("docker", ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]));
    const item: DockerCleanupItem = {
      project, jobId: group.job.id, state: group.job.state,
      containers: group.containers, volumes, networks, executed: !dryRun, ok: true,
      message: dryRun ? "remove terminal Compose resources proven by labels and ledger" : "removed terminal Compose resources",
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

function dockerLines(result: ExecResult): string[] {
  return result.ok ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function dockerError(result: ExecResult): string {
  return (result.error || result.stderr || `docker exited ${result.code ?? "unknown"}`).trim();
}
