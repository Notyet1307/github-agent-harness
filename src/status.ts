import {
  defaultLedgerPath,
  loadConfig,
} from "./config.js";
import { Ledger } from "./ledger.js";
import { requireOrcaCli, orcaStatus } from "./orca.js";
import { taskList, worktreePs } from "./orca-runtime.js";

export function formatStatus(options: {
  configPath?: string;
  ledgerPath?: string;
}): string {
  const config = loadConfig(options.configPath);
  const lines: string[] = ["harness status", ""];

  lines.push(`implementer profile: ${config.activeProfiles.implementer}`);
  lines.push(`auditor profile:     ${config.activeProfiles.auditor}`);
  lines.push("");

  const ledger = new Ledger(options.ledgerPath ?? defaultLedgerPath());
  try {
    const active = ledger.getActiveJob();
    if (!active) {
      lines.push("active job: (none)");
    } else {
      lines.push("active job:");
      lines.push(`  id:        ${active.id}`);
      lines.push(`  repo:      ${active.repo}#${active.issue_number}`);
      lines.push(`  state:     ${active.state}`);
      lines.push(`  branch:    ${active.branch ?? "-"}`);
      lines.push(`  base_sha:  ${active.base_sha ?? "-"}`);
      lines.push(`  head_sha:  ${active.head_sha ?? "-"}`);
      lines.push(`  worktree:  ${active.worktree_path ?? "-"}`);
      lines.push(
        `  profile:   ${active.implementer_profile_id ?? "-"}`,
      );
      lines.push(
        `  task:      ${active.implementer_task_id ?? "-"}`,
      );
      lines.push(
        `  error:     ${active.last_error ?? "-"}`,
      );
    }

    lines.push("");
    lines.push("recent jobs:");
    for (const j of ledger.listJobs(8)) {
      lines.push(
        `  ${j.updated_at}  ${j.state.padEnd(16)} ${j.repo}#${j.issue_number}`,
      );
    }
  } finally {
    ledger.close();
  }

  try {
    const orcaCli = requireOrcaCli(config);
    const st = orcaStatus(orcaCli);
    lines.push("");
    lines.push(
      `orca: appRunning=${st.appRunning} runtimeReady=${st.runtimeReady}`,
    );
    if (st.ok) {
      lines.push("");
      lines.push("orca worktree ps (summary):");
      lines.push(JSON.stringify(worktreePs(orcaCli), null, 2).slice(0, 2000));
      lines.push("");
      lines.push("orca orchestration tasks:");
      lines.push(JSON.stringify(taskList(orcaCli), null, 2).slice(0, 2000));
    }
  } catch (err) {
    lines.push(`orca: ${(err as Error).message}`);
  }

  return lines.join("\n");
}
