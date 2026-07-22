import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
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

  // Matt skills
  const skillRoot = join(process.env.HOME ?? "", ".agents/skills");
  for (const skill of ["implement", "code-review"] as const) {
    const skillPath = join(skillRoot, skill, "SKILL.md");
    checks.push({
      name: `skill:${skill}`,
      level: existsSync(skillPath) ? "ok" : "warn",
      detail: existsSync(skillPath)
        ? skillPath
        : `missing ${skillPath} (Codex implement path needs it)`,
    });
  }

  // Pi subagent example (not yet installed into target repos — warn only at M0)
  const piSubagentExample =
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent";
  checks.push({
    name: "pi-subagent-example",
    level: existsSync(piSubagentExample) ? "ok" : "warn",
    detail: existsSync(piSubagentExample)
      ? piSubagentExample
      : "official Pi subagent example not found (needed before M3)",
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
