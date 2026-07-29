#!/usr/bin/env node
import { defaultConfigPath, loadConfig } from "./config.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { pickAll } from "./picker.js";
import { runOnce } from "./run-once.js";
import { auditOnce } from "./audit-once.js";
import { publishOnce } from "./publisher.js";
import { waitMerge } from "./merge-monitor.js";
import { recover } from "./recover.js";
import { WorkCoordinator } from "./work.js";
import { watch } from "./watch.js";
import { formatStatus } from "./status.js";
import { Ledger } from "./ledger.js";
import { checkSetupIdle } from "./setup.js";
import { cancelJob, cleanupJobs, type LifecycleResult } from "./lifecycle.js";
import {
  addProject,
  ensureHarnessRepo,
  setupProjects,
  loadRuntimeConfig,
  type EnrollmentResult,
} from "./project.js";
import { defaultLedgerPath } from "./config.js";

function usage(): string {
  return `github-agent-harness

Usage:
  harness setup --repo OWNER/REPO --path /abs/repo [--default-branch name] [--base-ref remote/name] [--dry-run] [--config path]
  harness doctor [--config path]
  harness project add --repo OWNER/REPO --path /abs/repo [--default-branch name] [--base-ref remote/name] [--dry-run] [--config path]
  harness project setup [--repo OWNER/REPO | --all] [--dry-run] [--config path]
  harness pick --dry-run [--config path] [--repo OWNER/REPO]
  harness run-once [--config path] [--repo OWNER/REPO] [--issue N]
  harness audit-once [--config path] [--no-rework]
  harness publish-once [--config path]
  harness wait-merge [--config path] [--timeout-minutes N] [--poll-seconds N]
  harness recover [--config path] [--dry-run] [--execute] [--acknowledge-escalation | --reply text]
  harness cancel [--job ID] [--reason text] [--remove-worktree] [--dry-run | --execute] [--config path]
  harness cleanup [--job ID] [--dry-run | --execute] [--config path]
  harness work [--config path] [--repo OWNER/REPO] [--once] [--dry-run] [--max-cycles N] [--poll-seconds N]
  harness watch [--config path] [--once] [--dry-run] [--max-cycles N] [--poll-seconds N]
  harness status [--config path]
  harness help

Pipeline (V1):
  Picker → Claim → Worktree → Implement → Audit → Publish PR → Wait merge

M2–M5: one-shot commands
M6 watch: poll loop — resume active job, request GitHub auto-merge in auto mode, or claim next
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
  if (cmd === "setup") {
    const github = readFlag(args, "--repo");
    const localPath = readFlag(args, "--path");
    if (!github || !localPath) {
      process.stderr.write(
        "setup requires --repo OWNER/REPO and --path /abs/repo\n",
      );
      return 2;
    }

    const dryRun = args.includes("--dry-run");
    const projectInput = {
      configPath,
      github,
      localPath,
      defaultBranch: readFlag(args, "--default-branch"),
      baseRef: readFlag(args, "--base-ref"),
    };
    if (!dryRun) {
      const validation = addProject({ ...projectInput, dryRun: true });
      if (!validation.ok) {
        printEnrollmentResult(validation, true);
        return 1;
      }

      const idle = checkSetupIdle();
      if (!idle.ok) {
        process.stderr.write(
          `setup refused while job ${idle.jobId} is active (${idle.state})\n`,
        );
        return 1;
      }
    }
    let controller;
    try {
      controller = ensureHarnessRepo(loadConfig(configPath), dryRun);
    } catch (err) {
      process.stderr.write(`FAIL: ${(err as Error).message}\n`);
      return 1;
    }
    const controllerStatus = !controller.ok
      ? "FAIL"
      : dryRun
        ? "PLAN"
        : controller.applied
          ? "APPLY"
          : "OK";
    process.stdout.write(`${controllerStatus}: ${controller.message}\n`);
    if (!controller.ok) return 1;

    const result = addProject({ ...projectInput, dryRun });
    printEnrollmentResult(result, dryRun);
    if (!result.ok || dryRun) return result.ok ? 0 : 1;

    const report = runDoctor(configPath);
    process.stdout.write(`\n${formatDoctorReport(report)}\n`);
    return report.ok ? 0 : 1;
  }

  if (cmd === "project") {
    const subcommand = args[1];
    if (subcommand === "add") {
      const github = readFlag(args, "--repo");
      const localPath = readFlag(args, "--path");
      if (!github || !localPath) {
        process.stderr.write("project add requires --repo OWNER/REPO and --path /abs/repo\n");
        return 2;
      }
      const result = addProject({
        configPath,
        github,
        localPath,
        defaultBranch: readFlag(args, "--default-branch"),
        baseRef: readFlag(args, "--base-ref"),
        dryRun: args.includes("--dry-run"),
      });
      printEnrollmentResult(result, args.includes("--dry-run"));
      return result.ok ? 0 : 1;
    }
    if (subcommand === "setup") {
      const github = readFlag(args, "--repo");
      const all = args.includes("--all");
      const unknown = args
        .slice(2)
        .filter(
          (arg) =>
            arg.startsWith("--") &&
            !["--repo", "--all", "--dry-run", "--config"].includes(arg),
        );
      if (
        unknown.length > 0 ||
        (args.includes("--repo") && !github) ||
        Number(Boolean(github)) + Number(all) !== 1
      ) {
        process.stderr.write(
          "project setup requires exactly one of --repo OWNER/REPO or --all\n",
        );
        return 2;
      }
      const report = setupProjects({
        configPath,
        github,
        dryRun: args.includes("--dry-run"),
      });
      for (const result of report.results) {
        printEnrollmentResult(result, args.includes("--dry-run"));
      }
      if (report.results.length === 0) {
        process.stdout.write(`${report.ok ? "OK" : "FAIL"}: ${report.message}\n`);
      }
      return report.ok ? 0 : 1;
    }
    process.stderr.write("project requires add or setup\n");
    return 2;
  }

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
    const config = loadRuntimeConfig(configPath);
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
        const why = result.selected.mapNumber
          ? `frontier of Map #${result.selected.mapNumber} + open + label '${config.issueLabel}' + blockedBy empty + unassigned + not in ledger`
          : `open + label '${config.issueLabel}' + blockedBy empty + not in ledger`;
        process.stdout.write(`  why: ${why}\n`);
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

  if (cmd === "recover") {
    const acknowledgeEscalation = args.includes("--acknowledge-escalation");
    const decisionReply = readFlag(args, "--reply");
    if (acknowledgeEscalation && decisionReply != null) {
      process.stderr.write(
        "recover accepts only one of --acknowledge-escalation or --reply\n",
      );
      return 2;
    }
    // Default dry-run for safety; --execute resumes the pipeline step.
    const dryRun = !args.includes("--execute");
    const result = recover({
      configPath,
      dryRun,
      waitMergeTimeoutMinutes: 0,
      acknowledgeEscalation,
      decisionReply,
    });
    process.stdout.write(
      `\n${result.ok ? "OK" : "FAIL"}: ${result.message}\n`,
    );
    process.stdout.write(
      `action: ${result.action.kind}${result.executed ? " (executed)" : " (dry-run)"}\n`,
    );
    if (result.jobId) process.stdout.write(`job: ${result.jobId}\n`);
    if (result.details) {
      process.stdout.write(`${JSON.stringify(result.details, null, 2)}\n`);
    }
    if (dryRun && result.action.kind === "resolve_intervention") {
      process.stdout.write(
        result.action.intervention === "decision_gate"
          ? "\nAfter reviewing the request, use --execute --reply <text>.\n"
          : "\nAfter reviewing the escalation, use --execute --acknowledge-escalation.\n",
      );
    } else if (
      dryRun &&
      !["none", "noop", "blocked"].includes(result.action.kind)
    ) {
      process.stdout.write(
        "\nRe-run with --execute to resume the ensure* step.\n",
      );
    }
    return result.ok ? 0 : 1;
  }

  if (cmd === "cancel") {
    if (args.includes("--dry-run") && args.includes("--execute")) {
      process.stderr.write("cancel accepts only one of --dry-run or --execute\n");
      return 2;
    }
    const result = cancelJob({
      configPath,
      jobId: readFlag(args, "--job"),
      reason: readFlag(args, "--reason"),
      removeWorktree: args.includes("--remove-worktree"),
      dryRun: !args.includes("--execute"),
    });
    printLifecycleResult(result);
    return result.ok ? 0 : 1;
  }

  if (cmd === "cleanup") {
    if (args.includes("--dry-run") && args.includes("--execute")) {
      process.stderr.write("cleanup accepts only one of --dry-run or --execute\n");
      return 2;
    }
    const result = cleanupJobs({
      configPath,
      jobId: readFlag(args, "--job"),
      dryRun: !args.includes("--execute"),
    });
    printLifecycleResult(result);
    return result.ok ? 0 : 1;
  }

  if (cmd === "work") {
    const repoFilter = readFlag(args, "--repo");
    const maxRaw = readFlag(args, "--max-cycles");
    const pollRaw = readFlag(args, "--poll-seconds");
    const maxCycles = maxRaw != null ? Number(maxRaw) : 0;
    const pollSeconds = pollRaw != null ? Number(pollRaw) : 0;
    if (args.includes("--repo") && !repoFilter) {
      process.stderr.write("work --repo requires OWNER/REPO\n");
      return 2;
    }
    if (
      maxRaw != null &&
      (!Number.isSafeInteger(maxCycles) || maxCycles < 1)
    ) {
      process.stderr.write("invalid --max-cycles\n");
      return 2;
    }
    if (
      pollRaw != null &&
      (!Number.isFinite(pollSeconds) || pollSeconds < 0)
    ) {
      process.stderr.write("invalid --poll-seconds\n");
      return 2;
    }
    if (
      repoFilter &&
      !loadConfig(configPath).repositories.some(
        (repo) => repo.github === repoFilter,
      )
    ) {
      process.stderr.write(`repo not in config: ${repoFilter}\n`);
      return 2;
    }

    const result = new WorkCoordinator().run({
      configPath,
      repoFilter,
      once: args.includes("--once"),
      dryRun: args.includes("--dry-run"),
      maxCycles,
      pollSeconds,
    });
    process.stdout.write(
      `\n${result.ok ? "OK" : "FAIL"}: ${result.message} (cycles=${result.cycles})\n`,
    );
    process.stdout.write(
      `action: ${result.last.plan.action.kind} (${result.last.plan.execution})\n`,
    );
    if (result.last.plan.jobId) {
      process.stdout.write(`job: ${result.last.plan.jobId}\n`);
    }
    if (result.last.result?.details) {
      process.stdout.write(
        `${JSON.stringify(result.last.result.details, null, 2)}\n`,
      );
    }
    if (result.last.plan.execution === "explicit_recovery") {
      process.stdout.write(
        "\nStopped: inspect with recover --dry-run, then use recover --execute explicitly.\n",
      );
    }
    return result.ok ? 0 : 1;
  }

  if (cmd === "watch") {
    const maxRaw = readFlag(args, "--max-cycles");
    const pollRaw = readFlag(args, "--poll-seconds");
    const maxCycles = maxRaw != null ? Number(maxRaw) : 0;
    const pollSeconds = pollRaw != null ? Number(pollRaw) : undefined;
    if (maxRaw != null && !Number.isFinite(maxCycles)) {
      process.stderr.write("invalid --max-cycles\n");
      return 2;
    }
    if (pollRaw != null && !Number.isFinite(Number(pollRaw))) {
      process.stderr.write("invalid --poll-seconds\n");
      return 2;
    }
    const result = watch({
      configPath,
      once: args.includes("--once"),
      dryRun: args.includes("--dry-run"),
      maxCycles,
      pollSeconds,
    });
    process.stdout.write(
      `\n${result.ok ? "OK" : "FAIL"}: ${result.message} (cycles=${result.cycles})\n`,
    );
    return result.ok ? 0 : 1;
  }

  process.stderr.write(usage());
  return 2;
}

function printEnrollmentResult(
  result: EnrollmentResult,
  dryRun: boolean,
): void {
  const prefix = dryRun && result.ok ? "PLAN" : result.ok ? "OK" : "FAIL";
  process.stdout.write(`${prefix}: ${result.message}\n`);
  for (const check of result.checks) {
    process.stdout.write(`  ${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}\n`);
  }
  for (const action of result.actions) {
    process.stdout.write(
      `  ${action.applied ? "APPLIED" : "WOULD"} ${action.kind}\n`,
    );
  }
}

function printLifecycleResult(result: LifecycleResult): void {
  process.stdout.write(`${result.ok ? "OK" : "FAIL"}: ${result.message}\n`);
  for (const entry of result.items) {
    const prefix = entry.executed ? "APPLIED" : entry.ok ? "PLAN" : "REFUSE";
    process.stdout.write(
      `  ${prefix} ${entry.action} ${entry.repo}#${entry.issueNumber} ` +
        `(job ${entry.jobId}): ${entry.message}\n`,
    );
  }
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

process.exitCode = main(process.argv);
