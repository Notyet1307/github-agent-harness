import type { Job, WorkerIntervention } from "./types.js";

export function parseWorkerIntervention(
  job: Pick<Job, "intervention_json">,
): WorkerIntervention | null {
  if (!job.intervention_json) return null;
  try {
    const value = JSON.parse(job.intervention_json) as Partial<WorkerIntervention>;
    if (
      value.version !== 1 ||
      (value.kind !== "escalation" && value.kind !== "decision_gate") ||
      !["implementing", "auditing", "reworking"].includes(
        value.sourceState ?? "",
      ) ||
      (value.role !== "implementer" && value.role !== "auditor") ||
      typeof value.taskId !== "string" ||
      !value.taskId ||
      !(typeof value.dispatchId === "string" || value.dispatchId === null) ||
      !(typeof value.messageId === "string" || value.messageId === null) ||
      !(typeof value.headSha === "string" || value.headSha === null) ||
      !(typeof value.body === "string" || value.body === null) ||
      typeof value.observedAt !== "string"
    ) {
      return null;
    }
    return value as WorkerIntervention;
  } catch {
    return null;
  }
}

export function interventionError(value: WorkerIntervention): string {
  const id = value.messageId ? ` message ${value.messageId}` : "";
  return value.kind === "decision_gate"
    ? `worker requested a human decision${id}`
    : `worker sent escalation${id}`;
}
