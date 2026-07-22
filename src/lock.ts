import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Single-instance lock via pid file (wx create).
 * Stale lock is cleared if the pid is dead.
 */
export function acquireLock(lockPath: string): {
  ok: boolean;
  error?: string;
  release: () => void;
} {
  const release = () => {
    try {
      if (existsSync(lockPath)) {
        const cur = readFileSync(lockPath, "utf8").trim();
        if (cur === String(process.pid)) unlinkSync(lockPath);
      }
    } catch {
      // best-effort
    }
  };

  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, "utf8").trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
      return {
        ok: false,
        error: `another harness holds the lock (pid ${pid})`,
        release: () => {},
      };
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // race
    }
  }

  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch {
    return {
      ok: false,
      error: "failed to acquire lock (race)",
      release: () => {},
    };
  }

  return { ok: true, release };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
