import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, setupProjects } from "../src/project.js";
import { loadConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";

test("project add dry-run plans enrollment without mutating config or Orca", () => {
  const fixture = createFixture();
  try {
    const before = readFileSync(fixture.configPath, "utf8");
    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
      dryRun: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "planned");
    assert.deepEqual(result.project, {
      key: "acme/widget",
      github: "Acme/Widget",
      defaultBranch: "main",
      localPath: fixture.repoPath,
      baseRef: "origin/main",
      orcaRepoId: null,
    });
    assert.deepEqual(
      result.actions.map((action) => [action.kind, action.applied]),
      [
        ["register_orca", false],
        ["set_orca_base_ref", false],
        ["write_config", false],
      ],
    );
    assert.equal(readFileSync(fixture.configPath, "utf8"), before);
    assert.deepEqual(readCalls(fixture.callsPath), ["repo list --json"]);
  } finally {
    fixture.cleanup();
  }
});

test("project add enrolls a repository and is idempotent", () => {
  const fixture = createFixture();
  try {
    const originalMode = statSync(fixture.configPath).mode & 0o777;
    const created = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
    });

    assert.equal(created.ok, true);
    assert.equal(created.status, "created");
    assert.ok(created.actions.every((action) => action.applied));
    const config = loadConfig(fixture.configPath);
    assert.deepEqual(config.repositories, [
      {
        github: "Acme/Widget",
        localPath: fixture.repoPath,
        orcaRepoId: "orca-repo-1",
        baseRef: "origin/main",
        defaultBranch: "main",
      },
    ]);
    const written = readFileSync(fixture.configPath, "utf8");
    assert.match(written, /# enrollment fixture/);
    assert.match(written, /customField:\n  keep: true/);
    assert.equal(statSync(fixture.configPath).mode & 0o777, originalMode);

    const repeated = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
    });
    assert.equal(repeated.ok, true);
    assert.equal(repeated.status, "unchanged");
  } finally {
    fixture.cleanup();
  }
});

test("project setup repairs an existing Orca base ref", () => {
  const fixture = createFixture();
  try {
    const created = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
    });
    assert.equal(created.ok, true);

    writeFileSync(
      fixture.statePath,
      JSON.stringify({
        repo: {
          id: "orca-repo-1",
          path: fixture.repoPath,
          worktreeBaseRef: "origin/old-main",
        },
      }),
    );

    const report = setupProjects({
      configPath: fixture.configPath,
      github: "Acme/Widget",
    });

    assert.equal(report.ok, true);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0]?.status, "repaired");
    assert.deepEqual(
      report.results[0]?.actions.map((action) => [action.kind, action.applied]),
      [["set_orca_base_ref", true]],
    );
  } finally {
    fixture.cleanup();
  }
});

test("project add normalizes a repository subdirectory to the Git root", () => {
  const fixture = createFixture();
  try {
    const subdirectory = join(fixture.repoPath, "src");
    mkdirSync(subdirectory);
    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: subdirectory,
      dryRun: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.project?.localPath, fixture.repoPath);
  } finally {
    fixture.cleanup();
  }
});

test("project setup repairs a configured repository subdirectory", () => {
  const fixture = createFixture();
  try {
    const subdirectory = join(fixture.repoPath, "src");
    mkdirSync(subdirectory);
    writeFileSync(
      fixture.configPath,
      `# enrollment fixture
version: 1
issueLabel: ready-for-agent
repositories:
  - github: Acme/Widget
    localPath: ${JSON.stringify(subdirectory)}
    orcaRepoId: orca-repo-1
    baseRef: origin/main
    defaultBranch: main
orca:
  cliPath: ${JSON.stringify(join(fixture.dir, "orca.cjs"))}
  cliPathFallback: ${JSON.stringify(join(fixture.dir, "orca.cjs"))}
`,
    );
    writeFileSync(
      fixture.statePath,
      JSON.stringify({
        repo: {
          id: "orca-repo-1",
          path: fixture.repoPath,
          worktreeBaseRef: "origin/main",
          gitRemoteIdentity: { canonicalKey: "github.com/Acme/Widget" },
        },
      }),
    );

    const report = setupProjects({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      dryRun: true,
    });

    assert.equal(report.ok, true);
    assert.equal(report.results[0]?.status, "planned");
    assert.equal(report.results[0]?.project?.localPath, fixture.repoPath);
    assert.deepEqual(
      report.results[0]?.actions.map((action) => action.kind),
      ["write_config"],
    );
  } finally {
    fixture.cleanup();
  }
});

test("project add preserves unrelated repository YAML nodes", () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      fixture.configPath,
      `# enrollment fixture
version: 1
issueLabel: ready-for-agent
repositories:
  # keep repository comment
  - github: Existing/Repository # keep inline comment
    localPath: /tmp/existing-repository
    orcaRepoId: existing-id
    baseRef: origin/main
    defaultBranch: main
    futureField: keep-me
orca:
  cliPath: ${JSON.stringify(join(fixture.dir, "orca.cjs"))}
  cliPathFallback: ${JSON.stringify(join(fixture.dir, "orca.cjs"))}
customField:
  keep: true
`,
    );

    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
    });

    assert.equal(result.ok, true);
    const written = readFileSync(fixture.configPath, "utf8");
    assert.match(written, /# keep repository comment/);
    assert.match(written, /# keep inline comment/);
    assert.match(written, /futureField: keep-me/);
  } finally {
    fixture.cleanup();
  }
});

test("doctor fails when a configured Orca binding needs repair", () => {
  const fixture = createFixture();
  try {
    const created = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
    });
    assert.equal(created.ok, true);
    const config = readFileSync(fixture.configPath, "utf8").replace(
      "orcaRepoId: orca-repo-1",
      "orcaRepoId: stale-id",
    );
    writeFileSync(fixture.configPath, config);

    const report = runDoctor(fixture.configPath);
    const enrollment = report.checks.find(
      (check) => check.name === "repo:Acme/Widget:enrollment",
    );
    assert.equal(enrollment?.level, "fail");
    assert.match(enrollment?.detail ?? "", /write_config/);
  } finally {
    fixture.cleanup();
  }
});

test("project add requires origin to be the target GitHub repository", () => {
  const fixture = createFixture();
  try {
    git(fixture.repoPath, "remote", "set-url", "origin", "git@github.com:Acme/Fork.git");
    git(fixture.repoPath, "remote", "add", "upstream", "git@github.com:Acme/Widget.git");

    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
      dryRun: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /origin .* does not match Acme\/Widget/);
    assert.deepEqual(readCalls(fixture.callsPath), []);
  } finally {
    fixture.cleanup();
  }
});

test("project add rejects any origin push URL for another repository", () => {
  const fixture = createFixture();
  try {
    git(
      fixture.repoPath,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "git@github.com:Acme/Widget.git",
    );
    git(
      fixture.repoPath,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "git@github.com:Other/Repository.git",
    );

    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
      dryRun: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /origin push URL does not match Acme\/Widget/);
    assert.deepEqual(readCalls(fixture.callsPath), []);
  } finally {
    fixture.cleanup();
  }
});

test("project add rejects a base ref from a different remote", () => {
  const fixture = createFixture();
  try {
    git(fixture.repoPath, "remote", "add", "upstream", "git@github.com:Acme/Widget.git");
    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
      baseRef: "upstream/main",
      dryRun: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /baseRef must use origin/);
  } finally {
    fixture.cleanup();
  }
});

test("project add rejects an explicit default branch that does not exist", () => {
  const fixture = createFixture();
  try {
    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
      defaultBranch: "missing",
      baseRef: "origin/main",
      dryRun: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /default branch does not exist.*missing/);
  } finally {
    fixture.cleanup();
  }
});

test("project add rejects a base branch that does not exist on GitHub", () => {
  const fixture = createFixture();
  try {
    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
      baseRef: "origin/missing",
      dryRun: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /base branch does not exist.*missing/);
  } finally {
    fixture.cleanup();
  }
});

test("project add fails closed on a malformed Orca repository snapshot", () => {
  const fixture = createFixture();
  try {
    writeFileSync(fixture.statePath, JSON.stringify({ malformed: true }));
    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
      dryRun: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /invalid Orca repo list response/);
  } finally {
    fixture.cleanup();
  }
});

test("project add fails closed on a malformed Orca repository identity", () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      fixture.statePath,
      JSON.stringify({
        repo: {
          id: "orca-repo-1",
          path: fixture.repoPath,
          gitRemoteIdentity: { canonicalKey: 42 },
        },
      }),
    );

    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
      dryRun: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /invalid Orca repo list response/);
  } finally {
    fixture.cleanup();
  }
});

test("project add recovers after Orca succeeds but config writing fails", () => {
  const fixture = createFixture();
  try {
    chmodSync(fixture.configDir, 0o500);
    const first = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
    });
    assert.equal(first.ok, false);
    assert.match(first.message, /config write failed after Orca enrollment/);
    assert.deepEqual(loadConfig(fixture.configPath).repositories, []);

    chmodSync(fixture.configDir, 0o700);
    const second = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
    });
    assert.equal(second.ok, true);
    assert.equal(second.status, "created");
  } finally {
    chmodSync(fixture.configDir, 0o700);
    fixture.cleanup();
  }
});

test("project add converges after Orca registration partially succeeds", () => {
  const fixture = createFixture();
  try {
    writeFileSync(fixture.statePath, JSON.stringify({ failSetBaseOnce: true }));
    const first = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
    });
    assert.equal(first.ok, false);
    assert.deepEqual(
      first.actions.map((action) => [action.kind, action.applied]),
      [
        ["register_orca", true],
        ["set_orca_base_ref", false],
        ["write_config", false],
      ],
    );
    assert.deepEqual(loadConfig(fixture.configPath).repositories, []);

    const second = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
    });
    assert.equal(second.ok, true);
    assert.equal(second.status, "created");
    assert.equal(loadConfig(fixture.configPath).repositories[0]?.orcaRepoId, "orca-repo-1");
  } finally {
    fixture.cleanup();
  }
});

test("project add verifies the identity returned by a new Orca registration", () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      fixture.statePath,
      JSON.stringify({ addIdentity: "github.com/Other/Repository" }),
    );

    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /new Orca repo identity .* does not match Acme\/Widget/);
    assert.deepEqual(loadConfig(fixture.configPath).repositories, []);
  } finally {
    fixture.cleanup();
  }
});

test("project add reports a malformed identity from new Orca registration", () => {
  const fixture = createFixture();
  try {
    writeFileSync(fixture.statePath, JSON.stringify({ addIdentity: 42 }));

    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /orca repo add failed: invalid response/);
    assert.deepEqual(loadConfig(fixture.configPath).repositories, []);
  } finally {
    fixture.cleanup();
  }
});

test("project add fails closed when Orca path has another GitHub identity", () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      fixture.statePath,
      JSON.stringify({
        repo: {
          id: "orca-repo-1",
          path: fixture.repoPath,
          worktreeBaseRef: "origin/main",
          gitRemoteIdentity: {
            canonicalKey: "github.com/Other/Repository",
          },
        },
      }),
    );
    const before = readFileSync(fixture.configPath, "utf8");

    const result = addProject({
      configPath: fixture.configPath,
      github: "Acme/Widget",
      localPath: fixture.repoPath,
      dryRun: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /Orca repo identity .* does not match Acme\/Widget/);
    assert.equal(readFileSync(fixture.configPath, "utf8"), before);
  } finally {
    fixture.cleanup();
  }
});

test("CLI requires exactly one project setup scope", () => {
  const fixture = createFixture();
  try {
    const noScope = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "project", "setup", "--config", fixture.configPath],
      { encoding: "utf8", env: process.env },
    );
    assert.equal(noScope.status, 2);

    const bothScopes = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "project",
        "setup",
        "--config",
        fixture.configPath,
        "--repo",
        "Acme/Widget",
        "--all",
      ],
      { encoding: "utf8", env: process.env },
    );
    assert.equal(bothScopes.status, 2);
    assert.deepEqual(readCalls(fixture.callsPath), []);
  } finally {
    fixture.cleanup();
  }
});

test("CLI exposes project add dry-run", () => {
  const fixture = createFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "project",
        "add",
        "--config",
        fixture.configPath,
        "--repo",
        "Acme/Widget",
        "--path",
        fixture.repoPath,
        "--dry-run",
      ],
      { encoding: "utf8", env: process.env },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PLAN: project Acme\/Widget enrollment planned/);
    assert.match(result.stdout, /register_orca/);
    assert.match(result.stdout, /write_config/);
  } finally {
    fixture.cleanup();
  }
});

function createFixture(): {
  dir: string;
  repoPath: string;
  configPath: string;
  configDir: string;
  callsPath: string;
  statePath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "project-enrollment-"));
  const repoPath = join(dir, "repo");
  mkdirSync(repoPath);
  const canonicalRepoPath = realpathSync(repoPath);
  git(canonicalRepoPath, "init", "-b", "main");
  git(canonicalRepoPath, "remote", "add", "origin", "git@github.com:Acme/Widget.git");

  const callsPath = join(dir, "orca-calls.jsonl");
  const statePath = join(dir, "orca-state.json");
  const fakeOrca = join(dir, "orca.cjs");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "repo" && args[1] === "list") {
  console.log(JSON.stringify(state.malformed
    ? { ok: true, result: { unexpected: [] } }
    : { ok: true, result: { repos: state.repo ? [state.repo] : [] } }));
} else if (args[0] === "repo" && args[1] === "add") {
  state.repo = {
    id: "orca-repo-1",
    path: args[args.indexOf("--path") + 1],
    gitRemoteIdentity: {
      canonicalKey: state.addIdentity || "github.com/Acme/Widget"
    }
  };
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify({ ok: true, result: { repo: state.repo } }));
} else if (args[0] === "repo" && args[1] === "show") {
  console.log(JSON.stringify({ ok: true, result: { repo: state.repo } }));
} else if (args[0] === "repo" && args[1] === "set-base-ref") {
  if (state.failSetBaseOnce) {
    delete state.failSetBaseOnce;
    fs.writeFileSync(statePath, JSON.stringify(state));
    console.log(JSON.stringify({ ok: false, error: { message: "injected set-base-ref failure" } }));
    process.exitCode = 1;
  } else {
    state.repo.worktreeBaseRef = args[args.indexOf("--ref") + 1];
    fs.writeFileSync(statePath, JSON.stringify(state));
    console.log(JSON.stringify({ ok: true, result: { repo: state.repo } }));
  }
} else {
  console.log(JSON.stringify({ ok: false, error: { message: "unexpected " + args.join(" ") } }));
  process.exitCode = 1;
}
`,
  );
  chmodSync(fakeOrca, 0o755);

  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const fakeGh = join(binDir, "gh");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ defaultBranchRef: { name: "main" } }));
} else if (args[0] === "api" && args[1] === "repos/Acme/Widget/branches/main") {
  console.log(JSON.stringify({ name: "main" }));
} else {
  process.stderr.write("unexpected gh command: " + args.join(" "));
  process.exitCode = 1;
}
`,
  );
  chmodSync(fakeGh, 0o755);

  const configDir = join(dir, "config");
  mkdirSync(configDir);
  const configPath = join(configDir, "harness.yaml");
  writeFileSync(
    configPath,
    `# enrollment fixture
version: 1
issueLabel: ready-for-agent
repositories: []
orca:
  cliPath: ${JSON.stringify(fakeOrca)}
  cliPathFallback: ${JSON.stringify(fakeOrca)}
customField:
  keep: true
`,
  );

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;

  return {
    dir,
    repoPath: canonicalRepoPath,
    configPath,
    configDir,
    callsPath,
    statePath,
    cleanup: () => {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function readCalls(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as string[]).join(" "));
  } catch {
    return [];
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
