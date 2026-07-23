import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { HARNESS_ROOT, loadConfig } from "./config.js";
import { execFile, which } from "./exec.js";
import { ghAuthOk } from "./github.js";
import { orcaJson, orcaStatus, resolveOrcaCli } from "./orca.js";
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

  // codex / pi
  for (const bin of ["codex", "pi"] as const) {
    const path = which(bin);
    if (!path) {
      checks.push({ name: bin, level: "fail", detail: `${bin} not found` });
    } else {
      const ver = execFile(bin, ["--version"]);
      checks.push({
        name: bin,
        level: "ok",
        detail: `${path} (${(ver.stdout || ver.stderr).trim() || "version unknown"})`,
      });
    }
  }

  // Implementer skill
  const skillRoot = join(process.env.HOME ?? "", ".agents/skills");
  const implementSkillPath = join(skillRoot, "implement", "SKILL.md");
  checks.push({
    name: "skill:implement",
    level: existsSync(implementSkillPath) ? "ok" : "warn",
    detail: existsSync(implementSkillPath)
      ? implementSkillPath
      : `missing ${implementSkillPath} (Codex implement path needs it)`,
  });

  // Controller-owned Pi audit resources
  for (const [name, resourcePath] of [
    ["pi-auditor-launcher", join(HARNESS_ROOT, "scripts/pi-auditor")],
    [
      "pi-auditor-skill",
      join(HARNESS_ROOT, "pi/auditor/skills/matt-code-review-pi/SKILL.md"),
    ],
    [
      "pi-auditor-agent",
      join(HARNESS_ROOT, "pi/auditor/agents/harness-reviewer.md"),
    ],
  ] as const) {
    checks.push({
      name,
      level: existsSync(resourcePath) ? "ok" : "fail",
      detail: existsSync(resourcePath) ? resourcePath : `missing ${resourcePath}`,
    });
  }

  const piAgentDir =
    process.env.PI_CODING_AGENT_DIR ??
    join(process.env.HOME ?? "", ".pi/agent");
  const piSubagentsPackage = join(
    piAgentDir,
    "npm/node_modules/pi-subagents/package.json",
  );
  let piSubagentsOk = false;
  let piSubagentsDetail = `missing ${piSubagentsPackage}`;
  if (existsSync(piSubagentsPackage)) {
    try {
      const pkg = JSON.parse(readFileSync(piSubagentsPackage, "utf8")) as {
        name?: string;
        version?: string;
      };
      piSubagentsOk = pkg.name === "pi-subagents" && Boolean(pkg.version);
      piSubagentsDetail = `${pkg.name ?? "pi-subagents"}@${pkg.version ?? "unknown"} (${piSubagentsPackage})`;
    } catch (err) {
      piSubagentsDetail = `invalid ${piSubagentsPackage}: ${(err as Error).message}`;
    }
  }
  checks.push({
    name: "pi-subagents-package",
    level: piSubagentsOk ? "ok" : "fail",
    detail: piSubagentsDetail,
  });

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
  const impl = config.agentProfiles[config.activeProfiles.implementer];
  const aud = config.agentProfiles[config.activeProfiles.auditor];
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
  }

  for (const repo of config.repositories) {
    checks.push(...checkRepo(config, repo, orcaCli));
  }

  const ok = checks.every((c) => c.level !== "fail");
  return { ok, checks };
}

function checkRepo(
  config: HarnessConfig,
  repo: RepoConfig,
  orcaCli: string | null,
): Check[] {
  const checks: Check[] = [];
  const prefix = `repo:${repo.github}`;

  if (!existsSync(repo.localPath)) {
    checks.push({
      name: `${prefix}:localPath`,
      level: "fail",
      detail: `missing ${repo.localPath}`,
    });
    return checks;
  }
  checks.push({
    name: `${prefix}:localPath`,
    level: "ok",
    detail: repo.localPath,
  });

  const remote = execFile("git", ["-C", repo.localPath, "remote", "-v"]);
  checks.push({
    name: `${prefix}:git-remote`,
    level: remote.ok ? "ok" : "fail",
    detail: remote.ok
      ? remote.stdout.trim().split("\n")[0] ?? "ok"
      : remote.stderr || remote.error || "git remote failed",
  });

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

  if (orcaCli) {
    const shown = orcaJson(orcaCli, [
      "repo",
      "show",
      "--repo",
      `id:${repo.orcaRepoId}`,
    ]);
    if (!shown.ok) {
      checks.push({
        name: `${prefix}:orca-repo`,
        level: "fail",
        detail: shown.error ?? "orca repo show failed",
      });
    } else {
      const data = shown.data as {
        ok?: boolean;
        result?: { repo?: { path?: string; worktreeBaseRef?: string; id?: string } };
      };
      const orcaPath = data.result?.repo?.path;
      const baseRef = data.result?.repo?.worktreeBaseRef;
      const pathOk = orcaPath === repo.localPath;
      const baseOk = !baseRef || baseRef === repo.baseRef;
      checks.push({
        name: `${prefix}:orca-repo`,
        level: data.ok && pathOk ? "ok" : "fail",
        detail: `id=${repo.orcaRepoId} path=${orcaPath ?? "?"} baseRef=${baseRef ?? "(unset)"}`,
      });
      if (!baseOk) {
        checks.push({
          name: `${prefix}:orca-base-ref`,
          level: "warn",
          detail: `orca baseRef=${baseRef} config baseRef=${repo.baseRef}`,
        });
      } else if (baseRef) {
        checks.push({
          name: `${prefix}:orca-base-ref`,
          level: "ok",
          detail: baseRef,
        });
      }
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
