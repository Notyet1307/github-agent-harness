import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { defaultConfigPath, HARNESS_ROOT, loadConfig } from "./config.js";
import { execFile, which } from "./exec.js";
import { ghAuthOk } from "./github.js";
import { orcaStatus, resolveOrcaCli } from "./orca.js";
import {
  ensureHarnessRepo,
  loadOrcaRepoInventory,
  planProjectAdd,
  resolveProjectBindings,
  type OrcaRepo,
} from "./project.js";
import type { HarnessConfig, RepoConfig } from "./types.js";
// profiles validated inside loadConfig

export type CheckLevel = "ok" | "warn" | "fail";

export type Check = {
  name: string;
  level: CheckLevel;
  detail: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: Check[];
};

export function checkPiImplementerStartup(command: string): Check {
  const smoke = execFile(command, ["--print", "--no-session"], {
    timeoutMs: 30_000,
  });
  return {
    name: "profile:implementer-smoke",
    level: smoke.ok ? "ok" : "fail",
    detail: smoke.ok
      ? "launcher, explicit resources, and model selection start non-interactively"
      : smoke.stderr.trim() ||
        smoke.stdout.trim() ||
        smoke.error ||
        `launcher exited ${smoke.code ?? "unknown"}`,
  };
}

export function findPiAuditorAgentConflicts(
  piAgentDir: string,
  homeDir = process.env.HOME ?? "",
): string[] {
  return [join(piAgentDir, "agents"), join(homeDir, ".agents")].flatMap(
    (root) => findNamedAgentFiles(root, root, "harness-reviewer"),
  );
}

function findNamedAgentFiles(
  root: string,
  dir: string,
  agentName: string,
): string[] {
  if (!existsSync(dir)) return [];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === root && root.endsWith(".agents") && entry.name === "skills") {
        continue;
      }
      matches.push(...findNamedAgentFiles(root, path, agentName));
      continue;
    }
    if (
      (!entry.isFile() && !entry.isSymbolicLink()) ||
      !entry.name.endsWith(".md") ||
      entry.name.endsWith(".chain.md")
    ) {
      continue;
    }

    try {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
        readFileSync(path, "utf8"),
      )?.[1];
      const parsed = frontmatter ? parseYaml(frontmatter) : null;
      if (
        parsed &&
        typeof parsed === "object" &&
        "name" in parsed &&
        parsed.name === agentName &&
        "description" in parsed &&
        Boolean(parsed.description) &&
        (!("package" in parsed) || !parsed.package)
      ) {
        matches.push(path);
      }
    } catch {
      // Pi ignores unreadable or invalid agent definitions too.
    }
  }
  return matches;
}

export function runDoctor(configPath?: string): DoctorReport {
  const checks: Check[] = [];

  let config: HarnessConfig | null = null;
  try {
    config = loadConfig(configPath);
    checks.push({
      name: "config",
      level: "ok",
      detail: `loaded ${configPath ?? "config/harness.yaml"}`,
    });
  } catch (err) {
    checks.push({
      name: "config",
      level: "fail",
      detail: (err as Error).message,
    });
    return { ok: false, checks };
  }
  const impl = config.agentProfiles[config.activeProfiles.implementer];
  const aud = config.agentProfiles[config.activeProfiles.auditor];

  if (config.notifications.enabled) {
    const command = config.notifications.command[0]!;
    const commandPath = command.includes("/")
      ? (existsSync(command) ? command : null)
      : which(command);
    checks.push({
      name: "notifications:command",
      level: commandPath ? "ok" : "fail",
      detail: commandPath ?? `${command} not found`,
    });
  } else {
    checks.push({
      name: "notifications:command",
      level: "ok",
      detail: "disabled",
    });
  }

  // gh
  const ghPath = which("gh");
  if (!ghPath) {
    checks.push({ name: "gh", level: "fail", detail: "gh not found on PATH" });
  } else {
    const auth = ghAuthOk();
    checks.push({
      name: "gh",
      level: auth.ok ? "ok" : "fail",
      detail: auth.ok ? `${ghPath}; ${auth.detail}` : auth.detail,
    });
  }

  // Agent CLIs required by the active profiles.
  const activeAgentBins = new Set(
    [impl, aud]
      .filter((profile) => profile && !profile.command)
      .map((profile) => profile!.orcaAgent)
      .filter((bin): bin is "codex" | "pi" => bin === "codex" || bin === "pi"),
  );
  for (const bin of activeAgentBins) {
    const path = which(bin);
    if (!path) {
      checks.push({ name: bin, level: "fail", detail: `${bin} not found` });
    } else {
      const ver = execFile(bin, ["--version"]);
      checks.push({
        name: bin,
        level: ver.ok ? "ok" : "fail",
        detail: ver.ok
          ? `${path} (${ver.stdout.trim() || "version unknown"})`
          : ver.stderr.trim() || ver.error || `${bin} --version failed`,
      });
    }
  }

  if (impl?.orcaAgent === "codex") {
    const skillRoot = join(process.env.HOME ?? "", ".agents/skills");
    const implementSkillPath = join(skillRoot, "implement", "SKILL.md");
    checks.push({
      name: "skill:implement",
      level: existsSync(implementSkillPath) ? "ok" : "warn",
      detail: existsSync(implementSkillPath)
        ? implementSkillPath
        : `missing ${implementSkillPath} (Codex implement path needs it)`,
    });
  }

  const piAgentDir =
    process.env.PI_CODING_AGENT_DIR ??
    join(process.env.HOME ?? "", ".pi/agent");

  // Controller-owned Pi resources
  for (const [name, resourcePath] of [
    ["pi-runtime", join(HARNESS_ROOT, "node_modules/.bin/pi")],
    ["pi-implementer-launcher", join(HARNESS_ROOT, "scripts/pi-implementer")],
    [
      "pi-implementer-reviewer-child",
      join(HARNESS_ROOT, "scripts/pi-reviewer-child"),
    ],
    [
      "pi-implementer-skill:implement",
      join(HARNESS_ROOT, "pi/implementer/skills/implement/SKILL.md"),
    ],
    [
      "pi-implementer-skill:tdd",
      join(HARNESS_ROOT, "pi/implementer/skills/tdd/SKILL.md"),
    ],
    [
      "pi-implementer-skill:tdd-tests",
      join(HARNESS_ROOT, "pi/implementer/skills/tdd/tests.md"),
    ],
    [
      "pi-implementer-skill:tdd-mocking",
      join(HARNESS_ROOT, "pi/implementer/skills/tdd/mocking.md"),
    ],
    [
      "pi-implementer-skill:code-review",
      join(HARNESS_ROOT, "pi/implementer/skills/code-review/SKILL.md"),
    ],
    ["pi-auditor-launcher", join(HARNESS_ROOT, "scripts/pi-auditor")],
    [
      "pi-auditor-skill",
      join(HARNESS_ROOT, "pi/auditor/skills/matt-code-review-pi/SKILL.md"),
    ],
    [
      "pi-auditor-agent",
      join(HARNESS_ROOT, "pi/auditor/agents/harness-reviewer.md"),
    ],
    [
      "pi-implementer-extension:orca-prefill",
      join(piAgentDir, "extensions/orca-prefill.ts"),
    ],
    [
      "pi-implementer-extension:orca-status",
      join(piAgentDir, "extensions/orca-agent-status.ts"),
    ],
    [
      "pi-subagents-extension",
      join(HARNESS_ROOT, "node_modules/pi-subagents/index.ts"),
    ],
    [
      "pi-auditor-extension:orca-titlebar",
      join(piAgentDir, "extensions/orca-titlebar-spinner.ts"),
    ],
  ] as const) {
    checks.push({
      name,
      level: existsSync(resourcePath) ? "ok" : "fail",
      detail: existsSync(resourcePath) ? resourcePath : `missing ${resourcePath}`,
    });
  }

  const piSubagentsPackage = join(
    HARNESS_ROOT,
    "node_modules/pi-subagents/package.json",
  );
  const rootPackage = JSON.parse(
    readFileSync(join(HARNESS_ROOT, "package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  const expectedPiSubagents = rootPackage.devDependencies?.["pi-subagents"];
  let piSubagentsOk = false;
  let piSubagentsDetail = `missing ${piSubagentsPackage}`;
  if (existsSync(piSubagentsPackage)) {
    try {
      const pkg = JSON.parse(readFileSync(piSubagentsPackage, "utf8")) as {
        name?: string;
        version?: string;
      };
      piSubagentsOk =
        pkg.name === "pi-subagents" &&
        typeof expectedPiSubagents === "string" &&
        pkg.version === expectedPiSubagents;
      piSubagentsDetail = `${pkg.name ?? "pi-subagents"}@${pkg.version ?? "unknown"} (${piSubagentsPackage}; expected ${expectedPiSubagents ?? "missing package pin"})`;
    } catch (err) {
      piSubagentsDetail = `invalid ${piSubagentsPackage}: ${(err as Error).message}`;
    }
  }
  checks.push({
    name: "pi-subagents-package",
    level: piSubagentsOk ? "ok" : "fail",
    detail: piSubagentsDetail,
  });

  if (impl?.orcaAgent === "pi" && impl.command) {
    checks.push(checkPiImplementerStartup(impl.command));
  }

  const conflictingSubagents = [
    join(piAgentDir, "npm/node_modules/pi-sub-agent/package.json"),
    join(piAgentDir, "npm/node_modules/@tintinweb/pi-subagents/package.json"),
    join(piAgentDir, "npm/node_modules/@mjakl/pi-subagent/package.json"),
  ].filter(existsSync);
  checks.push({
    name: "pi-subagent-conflicts",
    level: conflictingSubagents.length === 0 ? "ok" : "fail",
    detail:
      conflictingSubagents.length === 0
        ? "no conflicting subagent packages"
        : conflictingSubagents.join(", "),
  });

  const conflictingAuditorAgents = findPiAuditorAgentConflicts(piAgentDir);
  checks.push({
    name: "pi-auditor-agent-conflicts",
    level: conflictingAuditorAgents.length === 0 ? "ok" : "fail",
    detail:
      conflictingAuditorAgents.length === 0
        ? "no user agent shadows harness-reviewer"
        : conflictingAuditorAgents.join(", "),
  });

  // Profiles
  checks.push({
    name: "profile:implementer",
    level: impl ? "ok" : "fail",
    detail: impl
      ? `${impl.id} role=${impl.role} orcaAgent=${impl.orcaAgent}`
      : "missing",
  });
  checks.push({
    name: "profile:auditor",
    level: aud ? "ok" : "fail",
    detail: aud
      ? `${aud.id} role=${aud.role} orcaAgent=${aud.orcaAgent} readonly=${Boolean(aud.readonly)}`
      : "missing",
  });

  // Orca
  let inventory: OrcaRepo[] | null = null;
  const orcaCli = resolveOrcaCli(config);
  if (!orcaCli) {
    checks.push({
      name: "orca-cli",
      level: "fail",
      detail: "orca CLI not found on PATH or fallback path",
    });
  } else {
    checks.push({ name: "orca-cli", level: "ok", detail: orcaCli });
    const status = orcaStatus(orcaCli);
    checks.push({
      name: "orca-runtime",
      level: status.ok ? "ok" : "fail",
      detail: status.ok
        ? "app running, runtime ready"
        : status.error ||
          `appRunning=${status.appRunning} runtimeReady=${status.runtimeReady}`,
    });
    const loaded = loadOrcaRepoInventory(config, orcaCli);
    if (!loaded.ok) {
      checks.push({
        name: "orca-repo-inventory",
        level: "fail",
        detail: loaded.error,
      });
    } else {
      inventory = loaded.repos;
      const controller = ensureHarnessRepo(config, true, inventory);
      const current = controller.ok && !controller.message.startsWith("would ");
      checks.push({
        name: "orca-controller-repo",
        level: current ? "ok" : "fail",
        detail: controller.message,
      });
    }
  }

  for (const project of config.repositories) {
    const prefix = `repo:${project.github}`;
    if (!orcaCli || !inventory) {
      checks.push({
        name: `${prefix}:enrollment`,
        level: "fail",
        detail: orcaCli ? "Orca repo inventory unavailable" : "orca CLI not found",
      });
      continue;
    }
    const resolved = resolveProjectBindings(
      { ...config, repositories: [project] },
      orcaCli,
      inventory,
    );
    if (!resolved.ok) {
      checks.push({
        name: `${prefix}:enrollment`,
        level: "fail",
        detail: resolved.error,
      });
      continue;
    }
    checks.push(...checkRepo(config, resolved.projects[0]!, inventory, configPath));
  }

  const ok = checks.every((c) => c.level !== "fail");
  return { ok, checks };
}

function checkRepo(
  config: HarnessConfig,
  repo: RepoConfig,
  inventory: OrcaRepo[],
  configPath?: string,
): Check[] {
  const checks: Check[] = [];
  const prefix = `repo:${repo.github}`;
  const enrollment = planProjectAdd({
    configPath: configPath ?? defaultConfigPath(),
    github: repo.github,
    localPath: repo.localPath,
    defaultBranch: repo.defaultBranch,
    baseRef: repo.baseRef,
    dryRun: true,
    orcaRepos: inventory,
  });
  for (const check of enrollment.checks) {
    checks.push({
      name: `${prefix}:${check.name}`,
      level: check.ok ? "ok" : "fail",
      detail: check.detail,
    });
  }
  if (!enrollment.ok) {
    checks.push({
      name: `${prefix}:enrollment`,
      level: "fail",
      detail: enrollment.message,
    });
  } else if (enrollment.actions.length > 0) {
    checks.push({
      name: `${prefix}:enrollment`,
      level: "fail",
      detail: `setup required: ${enrollment.actions.map((action) => action.kind).join(", ")}`,
    });
  } else {
    checks.push({
      name: `${prefix}:enrollment`,
      level: "ok",
      detail: "project binding is current",
    });
  }

  if (!existsSync(repo.localPath)) return checks;

  const agents =
    existsSync(join(repo.localPath, "AGENTS.md")) ||
    existsSync(join(repo.localPath, "CLAUDE.md"));
  checks.push({
    name: `${prefix}:agents-md`,
    level: agents ? "ok" : "warn",
    detail: agents
      ? "AGENTS.md or CLAUDE.md present"
      : "missing AGENTS.md/CLAUDE.md",
  });

  const tracker = join(repo.localPath, "docs/agents/issue-tracker.md");
  checks.push({
    name: `${prefix}:issue-tracker`,
    level: existsSync(tracker) ? "ok" : "warn",
    detail: existsSync(tracker) ? tracker : "missing docs/agents/issue-tracker.md",
  });

  // validation scripts in package.json if present
  const pkgPath = join(repo.localPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const needed = ["test", "lint", "typecheck", "build"];
      const missing = needed.filter((s) => !scripts[s]);
      checks.push({
        name: `${prefix}:validation-scripts`,
        level: missing.length === 0 ? "ok" : "warn",
        detail:
          missing.length === 0
            ? needed.join(", ")
            : `missing scripts: ${missing.join(", ")}`,
      });
    } catch (err) {
      checks.push({
        name: `${prefix}:validation-scripts`,
        level: "warn",
        detail: `package.json parse failed: ${(err as Error).message}`,
      });
    }
  }

  // issue label presence (read-only)
  const labels = execFile("gh", [
    "label",
    "list",
    "--repo",
    repo.github,
    "--json",
    "name",
    "--limit",
    "100",
  ]);
  if (labels.ok) {
    try {
      const names = (
        JSON.parse(labels.stdout) as Array<{ name: string }>
      ).map((l) => l.name);
      const has = names.includes(config.issueLabel);
      checks.push({
        name: `${prefix}:label`,
        level: has ? "ok" : "warn",
        detail: has
          ? `label '${config.issueLabel}' exists`
          : `label '${config.issueLabel}' missing on GitHub`,
      });
    } catch {
      checks.push({
        name: `${prefix}:label`,
        level: "warn",
        detail: "could not parse gh label list",
      });
    }
  }

  return checks;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["harness doctor", ""];
  for (const c of report.checks) {
    const mark = c.level === "ok" ? "OK  " : c.level === "warn" ? "WARN" : "FAIL";
    lines.push(`[${mark}] ${c.name}: ${c.detail}`);
  }
  lines.push("");
  lines.push(report.ok ? "Result: PASS (no failures)" : "Result: FAIL");
  return lines.join("\n");
}
