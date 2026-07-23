import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getImplementerProfile, loadConfig } from "../src/config.js";
import { checkPiImplementerStartup } from "../src/doctor.js";
import {
  renderImplementerSpec,
  renderReworkSpec,
} from "../src/prompts.js";

test("controller-owned implementation skills stay pinned to Matt upstream", () => {
  const expectedHashes = new Map([
    [
      "pi/implementer/skills/implement/SKILL.md",
      "6d3fd9e83b8f36e5213854779db49b256a457a7ebb4a503e53fa7dcff696adc3",
    ],
    [
      "pi/implementer/skills/tdd/SKILL.md",
      "5363bb2775679fe9311fbb67947f95359169c6e7f1fac77c0f25e190bca6cf2f",
    ],
    [
      "pi/implementer/skills/tdd/tests.md",
      "859f9e592c188fda4fc7277dd180e4ce9c7a2e13f6efe1f6f29eccc9d28c106a",
    ],
    [
      "pi/implementer/skills/tdd/mocking.md",
      "3ceb807fdf4a47d6a93d4d9a891e5ba6d362a6247bd08adc451feebfc17361ef",
    ],
  ]);

  for (const [path, expectedHash] of expectedHashes) {
    const hash = createHash("sha256")
      .update(readFileSync(join(process.cwd(), path)))
      .digest("hex");
    assert.equal(hash, expectedHash, path);
  }

  const reviewSkill = readFileSync(
    join(process.cwd(), "pi/implementer/skills/code-review/SKILL.md"),
    "utf8",
  );
  assert.match(
    reviewSkill,
    /upstream-commit: ed37663cc5fbef691ddfecd080dff42f7e7e350d/,
  );
  assert.match(reviewSkill, /agentScope: "user"/);
  assert.match(reviewSkill, /context: "fresh"/);
  assert.match(reviewSkill, /artifacts: false/);
  assert.match(reviewSkill, /Mysterious Name.*rename it/s);
  assert.match(reviewSkill, /Only the parent implementer may send `worker_done`/);
});

test("active implementer uses the controller-owned Pi writer profile", (t) => {
  const profile = getImplementerProfile(loadConfig());

  assert.equal(profile.id, "pi-implementer");
  assert.equal(profile.orcaAgent, "pi");
  assert.equal(Boolean(profile.readonly), false);
  assert.match(profile.command ?? "", /\/scripts\/pi-implementer$/);
  assert.match(profile.invokeHint, /\/skill:implement/);

  const root = mkdtempSync(join(tmpdir(), "harness-pi-implementer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const piAgentDir = join(root, "pi-agent");
  const fakeBinDir = join(root, "bin");
  const argsPath = join(root, "args.txt");
  const agentDirsPath = join(root, "agent-dirs.txt");
  const subagentBinaryPath = join(root, "subagent-binary.txt");
  const requiredResources = [
    join(piAgentDir, "extensions/orca-prefill.ts"),
    join(piAgentDir, "extensions/orca-agent-status.ts"),
    join(piAgentDir, "npm/node_modules/pi-subagents/index.ts"),
  ];
  for (const path of requiredResources) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  writeFileSync(
    join(piAgentDir, "npm/node_modules/pi-subagents/package.json"),
    '{"name":"pi-subagents","version":"0.35.1"}',
  );

  mkdirSync(fakeBinDir, { recursive: true });
  const fakePi = join(fakeBinDir, "pi");
  writeFileSync(
    fakePi,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$PI_ARGS_PATH"',
      'printf "%s\\n" "$PI_SUBAGENT_EXTRA_AGENT_DIRS" > "$PI_AGENT_DIRS_PATH"',
      'printf "%s\\n" "$PI_SUBAGENT_PI_BINARY" > "$PI_SUBAGENT_BINARY_PATH"',
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);

  const result = spawnSync(profile.command!, ["--test-tail"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      PI_AGENT_DIRS_PATH: agentDirsPath,
      PI_ARGS_PATH: argsPath,
      PI_CODING_AGENT_DIR: piAgentDir,
      PI_SUBAGENT_BINARY_PATH: subagentBinaryPath,
    },
  });

  assert.equal(
    result.status,
    0,
    result.stderr || result.error?.message || "implementer launcher did not run",
  );
  const args = readFileSync(argsPath, "utf8").trim().split("\n");
  const harnessRoot = process.cwd();
  for (const skillPath of [
    join(harnessRoot, "pi/implementer/skills/implement/SKILL.md"),
    join(harnessRoot, "pi/implementer/skills/tdd/SKILL.md"),
    join(harnessRoot, "pi/implementer/skills/code-review/SKILL.md"),
  ]) {
    assert.deepEqual(
      args.slice(args.indexOf(skillPath) - 1, args.indexOf(skillPath) + 1),
      ["--skill", skillPath],
    );
  }
  assert.deepEqual(
    args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2),
    ["--tools", "read,edit,write,bash,subagent"],
  );
  assert.ok(args.includes("--offline"));
  assert.ok(args.includes("--no-approve"));
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("--no-prompt-templates"));
  assert.equal(args.at(-1), "--test-tail");
  assert.doesNotMatch(args.join("\n"), /readseek/i);
  assert.doesNotMatch(args.join("\n"), /titlebar-spinner/);
  assert.equal(
    readFileSync(agentDirsPath, "utf8").trim(),
    join(harnessRoot, "pi/auditor/agents"),
  );
  assert.equal(
    readFileSync(subagentBinaryPath, "utf8").trim(),
    join(harnessRoot, "scripts/pi-reviewer-child"),
  );
});

test("doctor fails closed after a non-interactive Pi profile startup", (t) => {
  const root = mkdtempSync(join(tmpdir(), "harness-pi-doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const argsPath = join(root, "args.txt");
  const launcher = join(root, "pi-launcher");
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      `printf "%s\\n" "$@" > "${argsPath}"`,
      'echo "extension failed" >&2',
      "exit 23",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);

  const check = checkPiImplementerStartup(launcher);

  assert.equal(check.level, "fail");
  assert.equal(check.detail, "extension failed");
  assert.deepEqual(readFileSync(argsPath, "utf8").trim().split("\n"), [
    "--print",
    "--no-session",
  ]);
});

test("Pi implementer refuses an unpinned subagent extension", (t) => {
  const profile = getImplementerProfile(loadConfig());
  const root = mkdtempSync(join(tmpdir(), "harness-pi-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const piAgentDir = join(root, "pi-agent");
  for (const path of [
    join(piAgentDir, "extensions/orca-prefill.ts"),
    join(piAgentDir, "extensions/orca-agent-status.ts"),
    join(piAgentDir, "npm/node_modules/pi-subagents/index.ts"),
  ]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  writeFileSync(
    join(piAgentDir, "npm/node_modules/pi-subagents/package.json"),
    '{"name":"pi-subagents","version":"99.0.0"}',
  );

  const fakeBinDir = join(root, "bin");
  const markerPath = join(root, "pi-ran");
  mkdirSync(fakeBinDir, { recursive: true });
  const fakePi = join(fakeBinDir, "pi");
  writeFileSync(fakePi, `#!/bin/sh\ntouch "${markerPath}"\n`);
  chmodSync(fakePi, 0o755);

  const result = spawnSync(profile.command!, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: piAgentDir,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires pi-subagents@0\.35\.1/);
  assert.equal(
    spawnSync("test", ["-e", markerPath]).status,
    1,
    "Pi must not start with an unapproved extension version",
  );
});

test("Pi implementer refuses missing runtime extensions", (t) => {
  const profile = getImplementerProfile(loadConfig());
  const requiredPaths = [
    "extensions/orca-prefill.ts",
    "extensions/orca-agent-status.ts",
    "npm/node_modules/pi-subagents/index.ts",
  ];

  for (const missingPath of requiredPaths) {
    const root = mkdtempSync(join(tmpdir(), "harness-pi-missing-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const piAgentDir = join(root, "pi-agent");
    for (const resourcePath of requiredPaths) {
      if (resourcePath === missingPath) continue;
      const path = join(piAgentDir, resourcePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    }
    const packagePath = join(
      piAgentDir,
      "npm/node_modules/pi-subagents/package.json",
    );
    mkdirSync(dirname(packagePath), { recursive: true });
    writeFileSync(
      packagePath,
      '{"name":"pi-subagents","version":"0.35.1"}',
    );

    const fakeBinDir = join(root, "bin");
    const markerPath = join(root, "pi-ran");
    mkdirSync(fakeBinDir, { recursive: true });
    const fakePi = join(fakeBinDir, "pi");
    writeFileSync(fakePi, `#!/bin/sh\ntouch "${markerPath}"\n`);
    chmodSync(fakePi, 0o755);

    const result = spawnSync(profile.command!, [], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: piAgentDir,
      },
    });

    assert.notEqual(result.status, 0, missingPath);
    assert.match(result.stderr, new RegExp(missingPath.replace(".", "\\.")));
    assert.equal(
      spawnSync("test", ["-e", markerPath]).status,
      1,
      `Pi must not start without ${missingPath}`,
    );
  }
});

test("internal Pi reviewer children cannot inherit Orca lifecycle handles", (t) => {
  const root = mkdtempSync(join(tmpdir(), "harness-pi-child-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const fakeBinDir = join(root, "bin");
  const envNamesPath = join(root, "env-names.txt");
  const argsPath = join(root, "args.txt");
  mkdirSync(fakeBinDir, { recursive: true });
  const fakePi = join(fakeBinDir, "pi");
  writeFileSync(
    fakePi,
    [
      "#!/bin/sh",
      'env | cut -d= -f1 | sort > "$CHILD_ENV_NAMES_PATH"',
      'printf "%s\\n" "$@" > "$CHILD_ARGS_PATH"',
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);

  const lifecycleNames = [
    "ORCA_AGENT_HOOK_ENDPOINT",
    "ORCA_AGENT_HOOK_ENV",
    "ORCA_AGENT_HOOK_PORT",
    "ORCA_AGENT_HOOK_TOKEN",
    "ORCA_AGENT_HOOK_VERSION",
    "ORCA_AGENT_LAUNCH_TOKEN",
    "ORCA_PANE_KEY",
    "ORCA_PI_PREFILL",
    "ORCA_PI_STATUS_OWNED",
    "ORCA_TAB_ID",
    "ORCA_TERMINAL_HANDLE",
    "ORCA_WORKSPACE_ID",
    "ORCA_WORKTREE_ID",
  ];
  const result = spawnSync(
    join(process.cwd(), "scripts/pi-reviewer-child"),
    ["--child-tail"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...Object.fromEntries(lifecycleNames.map((name) => [name, "secret"])),
        CHILD_ARGS_PATH: argsPath,
        CHILD_ENV_NAMES_PATH: envNamesPath,
        ORCA_APP_VERSION: "keep",
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      },
    },
  );

  assert.equal(
    result.status,
    0,
    result.stderr || result.error?.message || "child wrapper did not run",
  );
  const envNames = new Set(
    readFileSync(envNamesPath, "utf8").trim().split("\n"),
  );
  for (const name of lifecycleNames) {
    assert.equal(envNames.has(name), false, name);
  }
  assert.equal(envNames.has("ORCA_APP_VERSION"), true);
  assert.equal(readFileSync(argsPath, "utf8").trim(), "--child-tail");
});

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
