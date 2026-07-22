#!/usr/bin/env node
import { defaultConfigPath, loadConfig } from "./config.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { pickAll } from "./picker.js";
import { runOnce } from "./run-once.js";
import { auditOnce } from "./audit-once.js";
import { publishOnce } from "./publisher.js";
import { waitMerge } from "./merge-monitor.js";
import { formatStatus } from "./status.js";
import { Ledger } from "./ledger.js";
import { defaultLedgerPath } from "./config.js";

function usage(): string {
  return `github-agent-harness

Usage:
  harness doctor [--config path]
  harness pick --dry-run [--config path] [--repo OWNER/REPO]
  harness run-once [--config path] [--repo OWNER/REPO] [--issue N]
  harness audit-once [--config path] [--no-rework]
  harness publish-once [--config path]
  harness wait-merge [--config path] [--timeout-minutes N] [--poll-seconds N]
  harness status [--config path]
  harness help

Pipeline (V1):
  Picker → Claim → Worktree → Implement → Audit → Publish PR → Wait merge

M2 run-once: implement only
M3 audit-once: Pi dual-axis gate (+ rework)
M4 publish-once / wait-merge: push+PR, poll until merged (no auto-merge)
`;
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  const cmd = args[0] ?? "help";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(usage());
    return 0;
  }

  const configPath = readFlag(args, "--config") ?? defaultConfigPath();

  if (cmd === "doctor") {
    const report = runDoctor(configPath);
    process.stdout.write(formatDoctorReport(report) + "\n");
    return report.ok ? 0 : 1;
  }

  if (cmd === "status") {
    process.stdout.write(formatStatus({ configPath }) + "\n");
    return 0;
  }

  if (cmd === "pick") {
    if (!args.includes("--dry-run")) {
      process.stderr.write(
        "pick currently requires --dry-run. Use run-once to claim.\n",
      );
      return 2;
    }
    const config = loadConfig(configPath);
    const onlyRepo = readFlag(args, "--repo");
    const repos = onlyRepo
      ? config.repositories.filter((r) => r.github === onlyRepo)
      : config.repositories;
    if (onlyRepo && repos.length === 0) {
      process.stderr.write(`repo not in config: ${onlyRepo}\n`);
      return 2;
    }

    let hasActiveJob = false;
    const ledgerByRepo = new Map<string, Set<number>>();
    try {
      const ledger = new Ledger(defaultLedgerPath());
      hasActiveJob = ledger.hasActiveJob();
      for (const r of repos) {
        ledgerByRepo.set(r.github, ledger.ledgerIssueNumbers(r.github));
      }
      ledger.close();
    } catch {
      // no ledger yet
    }

    const scoped = { ...config, repositories: repos };
    const results = pickAll(scoped, { ledgerByRepo, hasActiveJob });

    for (const result of results) {
      process.stdout.write(`\n## ${result.repo.github}\n`);
      if (result.selected) {
        process.stdout.write(
          `WOULD CLAIM: #${result.selected.number} ${result.selected.title}\n`,
        );
        process.stdout.write(`  url: ${result.selected.url}\n`);
        process.stdout.write(
          `  why: open + label '${config.issueLabel}' + blockedBy empty + not in ledger\n`,
        );
        process.stdout.write(
          `  implementer profile: ${config.activeProfiles.implementer}\n`,
        );
      } else {
        process.stdout.write("WOULD CLAIM: (none)\n");
      }
      if (result.eligible.length > 1) {
        process.stdout.write("Other eligible (not first):\n");
        for (const e of result.eligible.slice(1)) {
          process.stdout.write(`  - #${e.number} ${e.title}\n`);
        }
      }
      if (result.skipped.length > 0) {
        process.stdout.write("Skipped:\n");
        for (const s of result.skipped) {
          const n = s.number === 0 ? "-" : `#${s.number}`;
          process.stdout.write(
            `  - ${n} ${s.title} [${s.reason}]${s.detail ? ` ${s.detail}` : ""}\n`,
          );
        }
      }
    }
    process.stdout.write(
      "\n(dry-run: no ledger write, no worktree, no labels changed)\n",
    );
    return 0;
  }

  if (cmd === "run-once") {
    const issueRaw = readFlag(args, "--issue");
    const issueNumber = issueRaw ? Number(issueRaw) : undefined;
    if (issueRaw && !Number.isFinite(issueNumber)) {
      process.stderr.write(`invalid --issue ${issueRaw}\n`);
      return 2;
    }
    const result = runOnce({
      configPath,
      repoFilter: readFlag(args, "--repo"),
      issueNumber,
    });
    process.stdout.write(`\n${result.ok ? "OK" : "FAIL"}: ${result.message}\n`);
    if (result.jobId) process.stdout.write(`job: ${result.jobId}\n`);
    if (result.details) {
      process.stdout.write(`${JSON.stringify(result.details, null, 2)}\n`);
    }
    return result.ok ? 0 : 1;
  }

  if (cmd === "audit-once") {
    const result = auditOnce({
      configPath,
      withRework: !args.includes("--no-rework"),
    });
    process.stdout.write(`\n${result.ok ? "OK" : "FAIL"}: ${result.message}\n`);
    if (result.jobId) process.stdout.write(`job: ${result.jobId}\n`);
    if (result.details) {
      process.stdout.write(`${JSON.stringify(result.details, null, 2)}\n`);
    }
    return result.ok ? 0 : 1;
  }

  if (cmd === "publish-once") {
    const result = publishOnce({ configPath });
    process.stdout.write(`\n${result.ok ? "OK" : "FAIL"}: ${result.message}\n`);
    if (result.jobId) process.stdout.write(`job: ${result.jobId}\n`);
    if (result.details) {
      process.stdout.write(`${JSON.stringify(result.details, null, 2)}\n`);
    }
    return result.ok ? 0 : 1;
  }

  if (cmd === "wait-merge") {
    const timeoutRaw = readFlag(args, "--timeout-minutes");
    const pollRaw = readFlag(args, "--poll-seconds");
    const timeoutMinutes = timeoutRaw != null ? Number(timeoutRaw) : 60;
    const pollSeconds = pollRaw != null ? Number(pollRaw) : 30;
    if (!Number.isFinite(timeoutMinutes) || !Number.isFinite(pollSeconds)) {
      process.stderr.write("invalid --timeout-minutes or --poll-seconds\n");
      return 2;
    }
    const result = waitMerge({
      configPath,
      timeoutMinutes,
      pollSeconds,
    });
    process.stdout.write(`\n${result.ok ? "OK" : "FAIL"}: ${result.message}\n`);
    if (result.jobId) process.stdout.write(`job: ${result.jobId}\n`);
    if (result.details) {
      process.stdout.write(`${JSON.stringify(result.details, null, 2)}\n`);
    }
    // still awaiting after timeout is ok (exit 0); blocked is fail
    return result.ok ? 0 : 1;
  }

  process.stderr.write(usage());
  return 2;
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

process.exitCode = main(process.argv);
