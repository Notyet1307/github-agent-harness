import { existsSync } from "node:fs";
import { defaultLedgerPath } from "./config.js";
import { Ledger } from "./ledger.js";

export type SetupIdleResult =
  | { ok: true }
  | { ok: false; jobId: string; state: string };

export function checkSetupIdle(
  ledgerPath = defaultLedgerPath(),
): SetupIdleResult {
  if (!existsSync(ledgerPath)) return { ok: true };

  const ledger = new Ledger(ledgerPath);
  try {
    const active = ledger.getActiveJob();
    return active
      ? { ok: false, jobId: active.id, state: active.state }
      : { ok: true };
  } finally {
    ledger.close();
  }
}
