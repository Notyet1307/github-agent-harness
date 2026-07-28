import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Ledger } from "../src/ledger.js";
import { acquireLock } from "../src/lock.js";

async function waitForFile(
  path: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(20, undefined, { signal });
  }
}

test("waitMerge releases the PID lock while sleeping between polls", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-lock-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  const markerPath = join(dir, "sleeping");
  const releasePath = join(dir, "release-sleep");
  const ghCountPath = join(dir, "gh-count");
  const resultPath = join(dir, "result.json");
  const lockPath = join(dir, "harness.lock");
  const ledgerPath = join(dir, "harness.sqlite");
  const configPath = join(dir, "harness.yaml");
  const runnerPath = join(dir, "runner.mjs");
  writeFileSync(ghCountPath, "0");
  writeFileSync(join(dir, ".keep"), "");
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/owner/repo.git"],
    { cwd: dir },
  );
  await import("node:fs").then(({ mkdirSync }) => mkdirSync(binDir));

  const fakeSleep = join(binDir, "sleep");
  writeFileSync(
    fakeSleep,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(markerPath)}, "sleeping");
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(${JSON.stringify(releasePath)})) Atomics.wait(wait, 0, 0, 10);
`,
  );
  chmodSync(fakeSleep, 0o755);

  const fakeGh = join(binDir, "gh");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const countPath = ${JSON.stringify(ghCountPath)};
const count = Number(fs.readFileSync(countPath, "utf8")) + 1;
fs.writeFileSync(countPath, String(count));
console.log(JSON.stringify({
  number: 1,
  url: "https://example.test/pull/1",
  title: "Test PR",
  state: count === 1 ? "OPEN" : "MERGED",
  mergedAt: count === 1 ? null : "2026-07-26T01:00:00Z",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  statusCheckRollup: [],
  headRefName: "agent/issue-1",
  baseRefName: "main"
}));
`,
  );
  chmodSync(fakeGh, 0o755);

  const fakeOrca = join(binDir, "orca");
  writeFileSync(
    fakeOrca,
    `#!/usr/bin/env node
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
const key = args.slice(0, 2).join(" ");
if (args[0] === "status") {
  console.log(JSON.stringify({ ok: true, result: {
    app: { running: true }, runtime: { state: "ready", reachable: true }
  }}));
} else if (key === "repo list") {
  console.log(JSON.stringify({ ok: true, result: { repos: [{
    id: "repo-1",
    path: ${JSON.stringify(dir)},
    worktreeBaseRef: "origin/main",
    gitRemoteIdentity: { canonicalKey: "owner/repo" }
  }] } }));
} else if (key === "repo show") {
  console.log(JSON.stringify({ ok: true, result: { repo: {
    id: "repo-1",
    path: ${JSON.stringify(dir)},
    worktreeBaseRef: "origin/main",
    gitRemoteIdentity: { canonicalKey: "owner/repo" }
  } } }));
} else {
  console.log(JSON.stringify({ ok: true, result: {} }));
}
`,
  );
  chmodSync(fakeOrca, 0o755);

  writeFileSync(
    configPath,
    `version: 1
issueLabel: ready-for-agent
orca:
  cliPath: ${JSON.stringify(fakeOrca)}
  cliPathFallback: ${JSON.stringify(fakeOrca)}
  controllerTitle: test-controller
activeProfiles:
  implementer: codex-default
  auditor: pi-reviewer
agentProfiles:
  codex-default:
    id: codex-default
    role: implementer
    runtime: orca
    orcaAgent: codex
    invokeHint: implement
  pi-reviewer:
    id: pi-reviewer
    role: auditor
    runtime: orca
    orcaAgent: pi
    readonly: true
    invokeHint: audit
repositories:
  - github: owner/repo
    localPath: ${JSON.stringify(dir)}
    orcaRepoId: repo-1
    baseRef: origin/main
    defaultBranch: main
`,
  );

  const ledger = new Ledger(ledgerPath);
  const claimed = ledger.tryClaim({
    id: "job-1",
    project: {
      github: "owner/repo",
      localPath: dir,
      orcaRepoId: "repo-1",
      baseRef: "origin/main",
      defaultBranch: "main",
    },
    issue: {
      number: 1,
      title: "Wait for merge",
      url: "https://example.test/issues/1",
      updatedAt: "2026-07-26T00:00:00Z",
      blockedBy: [],
      labels: ["ready-for-agent"],
    },
    baseSha: "a".repeat(40),
    implementerProfileId: "codex-default",
  });
  assert.equal(claimed.ok, true);
  ledger.updateJob("job-1", {
    state: "awaiting_merge",
    pr_number: 1,
    pr_url: "https://example.test/pull/1",
  });
  ledger.close();

  const mergeModuleUrl = pathToFileURL(
    join(process.cwd(), "src", "merge-monitor.ts"),
  ).href;
  writeFileSync(
    runnerPath,
    `import { writeFileSync } from "node:fs";
import { waitMerge } from ${JSON.stringify(mergeModuleUrl)};
const result = waitMerge({
  configPath: ${JSON.stringify(configPath)},
  ledgerPath: ${JSON.stringify(ledgerPath)},
  lockPath: ${JSON.stringify(lockPath)},
  timeoutMinutes: 1,
  pollSeconds: 1,
});
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
`,
  );

  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const closePromise = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  const markerWait = new AbortController();

  try {
    await Promise.race([
      waitForFile(markerPath, markerWait.signal),
      closePromise.then((exitCode) => {
        throw new Error(
          `child closed before writing ${markerPath} (exit ${exitCode})\n` +
            `stdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }),
    ]);
    markerWait.abort();

    const competingLock = acquireLock(lockPath);
    if (competingLock.ok) competingLock.release();
    writeFileSync(releasePath, "continue");

    const exitCode = await closePromise;

    assert.equal(
      competingLock.ok,
      true,
      competingLock.error ?? "lock was unavailable during merge poll sleep",
    );
    assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
      ok: boolean;
    };
    assert.equal(result.ok, true);
    const after = new Ledger(ledgerPath);
    assert.equal(after.getJob("job-1")?.state, "merged");
    after.close();
  } finally {
    markerWait.abort();
    if (!existsSync(releasePath)) writeFileSync(releasePath, "continue");
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closePromise;
  }
});
