import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  defaultConfigPath,
  defaultLedgerPath,
  defaultLockPath,
  loadConfig,
} from "./config.js";
import { execFile, type ExecResult } from "./exec.js";
import { parseWorkerIntervention } from "./intervention.js";
import { Ledger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import type { Job, NotificationConfig, WorkerIntervention } from "./types.js";

export type NotificationResult = {
  ok: boolean;
  status: "disabled" | "none" | "not_due" | "dry_run" | "sent" | "failed";
  message: string;
  rendered?: string;
  reminderMinutes?: number;
  attempt?: number;
};

type NotificationExec = typeof execFile;

export function notifyActiveIntervention(options: {
  configPath?: string;
  ledgerPath?: string;
  lockPath?: string;
  dryRun?: boolean;
  now?: Date;
  exec?: NotificationExec;
} = {}): NotificationResult {
  const config = loadConfig(options.configPath ?? defaultConfigPath());
  if (!config.notifications.enabled) {
    return { ok: true, status: "disabled", message: "notifications disabled" };
  }

  const ledgerPath = options.ledgerPath ?? defaultLedgerPath();
  const lockPath = options.lockPath ?? defaultLockPath();
  mkdirSync(dirname(lockPath), { recursive: true });
  const lock = acquireLock(lockPath);
  if (!lock.ok) {
    return { ok: false, status: "failed", message: lock.error ?? "lock busy" };
  }

  let ledger: Ledger | null = null;
  let planned:
    | {
        job: Job;
        intervention: WorkerIntervention;
        eventKey: string;
        reminderMinutes: number;
        rendered: string;
        attempt: number;
      }
    | undefined;
  try {
    ledger = new Ledger(ledgerPath);
    const job = ledger.getActiveJob();
    const intervention = job ? parseWorkerIntervention(job) : null;
    if (!job || !intervention || job.intervention_resolved_at) {
      return {
        ok: true,
        status: "none",
        message: "no unresolved worker intervention",
      };
    }

    const eventKey = interventionEventKey(job, intervention);
    const reminderMinutes = nextReminder(
      ledger,
      eventKey,
      intervention,
      config.notifications,
      options.now ?? new Date(),
    );
    if (reminderMinutes == null) {
      return {
        ok: true,
        status: "not_due",
        message: "intervention notification already delivered or not due",
      };
    }
    const rendered = renderInterventionNotification(
      job,
      intervention,
      reminderMinutes,
    );
    if (options.dryRun) {
      return {
        ok: true,
        status: "dry_run",
        message: `would send ${intervention.kind} notification (${reminderMinutes}m)`,
        rendered,
        reminderMinutes,
      };
    }
    const reservation = ledger.reserveNotificationAttempt({
      eventKey,
      jobId: job.id,
      reminderMinutes,
      maxAttempts: config.notifications.maxAttemptsPerReminder,
    });
    if (!reservation) {
      return {
        ok: true,
        status: "not_due",
        message: "notification was delivered or reserved concurrently",
      };
    }
    planned = {
      job,
      intervention,
      eventKey,
      reminderMinutes,
      rendered,
      attempt: reservation.attempts,
    };
  } finally {
    ledger?.close();
    lock.release();
  }

  const command = config.notifications.command;
  const execution = (options.exec ?? execFile)(command[0]!, command.slice(1), {
    input: planned.rendered,
    timeoutMs: config.notifications.timeoutSeconds * 1000,
  });
  const error = execution.ok ? undefined : summarizeExecFailure(execution);

  const completionLock = acquireLock(lockPath);
  if (!completionLock.ok) {
    return {
      ok: false,
      status: "failed",
      message: `notification command ${execution.ok ? "succeeded" : "failed"}, but delivery state could not be recorded: ${completionLock.error}`,
      rendered: planned.rendered,
      reminderMinutes: planned.reminderMinutes,
      attempt: planned.attempt,
    };
  }
  try {
    const completionLedger = new Ledger(ledgerPath);
    try {
      completionLedger.completeNotificationAttempt({
        eventKey: planned.eventKey,
        reminderMinutes: planned.reminderMinutes,
        delivered: execution.ok,
        error,
      });
    } finally {
      completionLedger.close();
    }
  } finally {
    completionLock.release();
  }

  return execution.ok
    ? {
        ok: true,
        status: "sent",
        message: `${planned.intervention.kind} notification sent (${planned.reminderMinutes}m, attempt ${planned.attempt})`,
        reminderMinutes: planned.reminderMinutes,
        attempt: planned.attempt,
      }
    : {
        ok: false,
        status: "failed",
        message: `${planned.intervention.kind} notification failed (${planned.reminderMinutes}m, attempt ${planned.attempt}): ${error}`,
        reminderMinutes: planned.reminderMinutes,
        attempt: planned.attempt,
      };
}

function nextReminder(
  ledger: Ledger,
  eventKey: string,
  intervention: WorkerIntervention,
  config: NotificationConfig,
  now: Date,
): number | null {
  const observed = Date.parse(intervention.observedAt);
  const elapsedMinutes = Number.isFinite(observed)
    ? Math.max(0, (now.getTime() - observed) / 60_000)
    : 0;
  for (const reminder of config.reminderMinutes) {
    if (reminder > elapsedMinutes) continue;
    const delivery = ledger.getNotificationDelivery(eventKey, reminder);
    if (!delivery?.delivered_at && (delivery?.attempts ?? 0) < config.maxAttemptsPerReminder) {
      return reminder;
    }
  }
  return null;
}

export function interventionEventKey(
  job: Pick<Job, "id">,
  intervention: WorkerIntervention,
): string {
  return [
    job.id,
    intervention.kind,
    intervention.taskId,
    intervention.dispatchId ?? "-",
    intervention.messageId ?? "-",
    intervention.observedAt,
  ].join(":");
}

export function renderInterventionNotification(
  job: Job,
  intervention: WorkerIntervention,
  reminderMinutes = 0,
): string {
  const issue = parseIssueTitle(job.issue_snapshot_json);
  const structured = structuredWorkerGuidance(intervention.payload);
  const advice = conservativeAdvice(intervention);
  const replyCommand =
    intervention.kind === "decision_gate"
      ? `pnpm harness recover --execute --reply ${shellQuote(advice.suggestedReply)}`
      : "pnpm harness recover --execute --acknowledge-escalation";
  const heading = reminderMinutes > 0 ? `Harness 人工介入提醒（${reminderMinutes} 分钟）` : "Harness 需要人工介入";
  const lines = [
    heading,
    "",
    `任务：${job.repo}#${job.issue_number}${issue ? ` ${issue}` : ""}`,
    `Job：${job.id}（通知时 revision ${job.revision}）`,
    `阶段：${intervention.sourceState} / ${intervention.role}`,
    `类型：${intervention.kind}`,
    `HEAD：${intervention.headSha ?? job.head_sha ?? "unknown"}`,
    `Task：${intervention.taskId}`,
    `Dispatch：${intervention.dispatchId ?? "unknown"}`,
    `Message：${intervention.messageId ?? "unknown"}`,
    "",
    "Worker 请求：",
    intervention.body?.trim() || "（未提供文本；请检查 payload 或 worker 终端）",
  ];
  if (structured.length > 0) {
    lines.push("", "Worker 提供的决策信息：", ...structured);
  }
  lines.push(
    "",
    `Harness 建议：${advice.summary}`,
    `理由：${advice.rationale}`,
    "",
    "处理命令（请先审阅，再复制执行）：",
    replyCommand,
    "",
    "查看当前证据：pnpm harness recover",
    "注意：通知失败或收到 Telegram 回复都不会自动解除 blocked。",
  );
  return `${lines.join("\n")}\n`;
}

export function conservativeAdvice(intervention: WorkerIntervention): {
  summary: string;
  rationale: string;
  suggestedReply: string;
} {
  const text = `${intervention.body ?? ""} ${safeJson(intervention.payload)}`.toLowerCase();
  if (hasAny(text, [
    "migration", "migrate", "schema", "historical data", "scope expansion",
    "scope creep", "destructive", "delete", "production", "security",
    "数据库", "迁移", "历史数据", "扩大范围", "超出范围", "删除", "生产环境", "安全",
  ])) {
    return {
      summary: "保持原 Issue 范围，避免不可逆、全局或数据迁移变更；额外风险拆成独立任务。",
      rationale: "这类选择可能扩大影响面或让升级不可回滚，默认应由人确认后再继续。",
      suggestedReply: "保持原 Issue 范围；不要执行不可逆、全局或历史数据迁移变更；将额外风险拆成独立 Issue。",
    };
  }
  if (hasAny(text, [
    "credential", "token", "permission", "access denied", "unauthorized",
    "凭据", "令牌", "权限", "无权", "未授权",
  ])) {
    return {
      summary: "继续保持 blocked，只补充完成当前任务所需的最小权限或信息。",
      rationale: "凭据与授权不能由 worker 猜测，也不应通过扩大权限绕过。",
      suggestedReply: "继续保持 blocked；请明确列出完成当前 Issue 所缺的最小权限或信息，不要扩大授权范围。",
    };
  }
  return {
    summary: "选择最小、可逆且不超出 Issue 范围的处理；信息不足时继续保持 blocked。",
    rationale: "保守方案最容易审计和回退，也避免 worker 用猜测替代人工决策。",
    suggestedReply: "采用最小、可逆且不超出 Issue 范围的方案；若信息仍不足，请继续保持 blocked 并说明缺口。",
  };
}

function structuredWorkerGuidance(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const output: string[] = [];
  for (const [label, keys] of [
    ["问题", ["question"]],
    ["选项", ["options"]],
    ["Worker 推荐", ["recommendation", "recommendedOption"]],
    ["理由", ["rationale", "reason"]],
    ["风险", ["risks", "risk"]],
  ] as const) {
    const value = firstField(record, keys);
    if (value !== undefined) output.push(`- ${label}：${formatValue(value)}`);
  }
  return output;
}

function firstField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  for (const nested of ["decision", "details", "data"]) {
    const value = record[nested];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const key of keys) {
        const found = (value as Record<string, unknown>)[key];
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(formatValue).join("；");
  return safeJson(value).slice(0, 1_000);
}

function parseIssueTitle(snapshot: string): string | null {
  try {
    const value = JSON.parse(snapshot) as { title?: unknown };
    return typeof value.title === "string" ? value.title : null;
  } catch {
    return null;
  }
}

function summarizeExecFailure(result: ExecResult): string {
  return (result.error || result.stderr.trim() || `exit ${result.code ?? "unknown"}`).slice(0, 1_000);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
