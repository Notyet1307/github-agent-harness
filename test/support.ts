import type { RepoConfig } from "../src/types.js";

export function testProject(github = "owner/repo"): RepoConfig {
  return {
    github,
    localPath: "/tmp/project",
    baseRef: "origin/main",
    defaultBranch: "main",
    orcaRepoId: "orca-test",
  };
}
