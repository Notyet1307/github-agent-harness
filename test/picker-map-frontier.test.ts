import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickForRepo } from "../src/picker.js";
import type { HarnessConfig, RepoConfig } from "../src/types.js";

type RawIssue = {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  state: string;
  labels: Array<{ name: string }>;
  blockedBy: { nodes: RawReference[]; totalCount: number };
  subIssues: { nodes: RawReference[]; totalCount: number };
  subIssuesSummary: { completed: number; percentCompleted: number; total: number };
  assignees: Array<{ login: string }>;
  parent: RawReference | null;
};

type RawReference = {
  number: number;
  title: string;
  state: string;
};

type Fixture = {
  list: RawIssue[];
  views?: Record<string, RawIssue>;
  listError?: string;
};

const repo: RepoConfig = {
  github: "owner/repo",
  localPath: "/tmp/repo",
  orcaRepoId: "repo-1",
  baseRef: "origin/main",
  defaultBranch: "main",
};

const config: HarnessConfig = {
  version: 1,
  issueLabel: "ready-for-agent",
  pollIntervalSeconds: 120,
  maxConcurrentTotal: 1,
  maxAuditRounds: 3,
  implementTimeoutMinutes: 45,
  auditTimeoutMinutes: 45,
  mergePolicy: { mode: "wait", autoMerge: false },
  orca: {
    cliPath: "orca",
    cliPathFallback: "orca",
    controllerWorktreePath: "/tmp/controller",
    controllerTitle: "controller",
  },
  activeProfiles: { implementer: "implementer", auditor: "auditor" },
  agentProfiles: {
    implementer: {
      id: "implementer",
      role: "implementer",
      runtime: "orca",
      orcaAgent: "pi",
      invokeHint: "implement",
    },
    auditor: {
      id: "auditor",
      role: "auditor",
      runtime: "orca",
      orcaAgent: "pi",
      invokeHint: "audit",
      readonly: true,
    },
  },
  repositories: [repo],
};

test("Wayfinder Map selects the Exposure frontier instead of its parent", (t) => {
  const map = issue(3, {
    subIssues: [reference(4, "CLOSED"), reference(5), reference(6)],
  });
  const child5 = issue(5, {
    parent: reference(3),
    blockedBy: [reference(4, "CLOSED")],
  });
  const child6 = issue(6, {
    parent: reference(3),
    blockedBy: [reference(5)],
  });

  withFakeGh(t, { list: [map, child5, child6] });
  const result = pickForRepo(config, repo);

  assert.equal(result.selected?.number, 5);
  assert.equal(result.selected?.mapNumber, 3);
  assert.equal(result.skipped.some((skip) => skip.number === 3 && skip.reason === "map-container"), true);
  assert.equal(result.skipped.some((skip) => skip.number === 6 && skip.reason === "blocked"), true);
});

test("Map order wins over child issue number", (t) => {
  const map = issue(3, {
    subIssues: [reference(20), reference(10)],
  });
  const child10 = issue(10, { parent: reference(3) });
  const child20 = issue(20, { parent: reference(3) });

  withFakeGh(t, { list: [map, child10, child20] });
  const result = pickForRepo(config, repo);

  assert.equal(result.selected?.number, 20);
  assert.equal(result.selected?.mapNumber, 3);
});

test("Map frontier drops assigned, blocked, and ledger children", (t) => {
  const map = issue(3, {
    subIssues: [reference(5), reference(6), reference(7), reference(8)],
  });
  const assigned = issue(5, {
    parent: reference(3),
    assignees: ["someone"],
  });
  const blocked = issue(6, {
    parent: reference(3),
    blockedBy: [reference(4)],
  });
  const inLedger = issue(7, { parent: reference(3) });
  const frontier = issue(8, { parent: reference(3) });

  withFakeGh(t, { list: [map, assigned, blocked, inLedger, frontier] });
  const result = pickForRepo(config, repo, {
    ledgerIssueNumbers: new Set([7]),
  });

  assert.equal(result.selected?.number, 8);
  assert.equal(result.skipped.some((skip) => skip.number === 5 && skip.reason === "assigned"), true);
  assert.equal(result.skipped.some((skip) => skip.number === 6 && skip.reason === "blocked"), true);
  assert.equal(result.skipped.some((skip) => skip.number === 7 && skip.reason === "already-in-ledger"), true);
});

test("an open child missing the ready label closes that Map frontier", (t) => {
  const map = issue(3, {
    subIssues: [reference(5), reference(6)],
  });
  const laterChild = issue(6, { parent: reference(3) });

  withFakeGh(t, { list: [map, laterChild] });
  const result = pickForRepo(config, repo);

  assert.equal(result.selected, null);
  assert.match(
    result.skipped.find((skip) => skip.number === 3)?.detail ?? "",
    /open child #5 is not ready/,
  );
});

test("a Map without a frontier does not block a later standalone issue", (t) => {
  const map = issue(3, { subIssues: [reference(5)] });
  const standalone = issue(4);
  const blockedChild = issue(5, {
    parent: reference(3),
    blockedBy: [reference(2)],
  });

  withFakeGh(t, { list: [map, standalone, blockedChild] });
  const result = pickForRepo(config, repo);

  assert.equal(result.selected?.number, 4);
  assert.equal(result.selected?.mapNumber, undefined);
});

test("a fresh assignee prevents claiming the listed frontier", (t) => {
  const map = issue(3, { subIssues: [reference(5)] });
  const child = issue(5, { parent: reference(3) });
  const assignedView = issue(5, {
    parent: reference(3),
    assignees: ["claimed-elsewhere"],
  });

  withFakeGh(t, {
    list: [map, child],
    views: { "3": map, "5": assignedView },
  });
  const result = pickForRepo(config, repo);

  assert.equal(result.selected, null);
  assert.equal(result.skipped.some((skip) => skip.number === 5 && skip.reason === "assigned"), true);
});

test("a child referenced by two Maps fails closed", (t) => {
  const map3 = issue(3, { subIssues: [reference(7)] });
  const map4 = issue(4, { subIssues: [reference(7)] });
  const child = issue(7, { parent: reference(3) });

  withFakeGh(t, { list: [map3, map4, child] });
  const result = pickForRepo(config, repo);

  assert.equal(result.selected, null);
  assert.equal(
    result.skipped.filter((skip) => skip.reason === "unsupported-topology").length,
    2,
  );
});

test("unsupported gh relation fields fail closed without the legacy picker", (t) => {
  withFakeGh(t, {
    list: [issue(1)],
    listError: "Unknown JSON field: subIssues",
  });
  const result = pickForRepo(config, repo);

  assert.equal(result.selected, null);
  assert.equal(result.eligible.length, 0);
  assert.match(result.skipped[0]?.detail ?? "", /Unknown JSON field: subIssues/);
});

function withFakeGh(t: TestContext, fixture: Fixture): void {
  const dir = mkdtempSync(join(tmpdir(), "harness-wayfinder-"));
  const fixturePath = join(dir, "fixture.json");
  const ghPath = join(dir, "gh");
  writeFileSync(fixturePath, JSON.stringify(fixture));
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const fixture = JSON.parse(fs.readFileSync(process.env.HARNESS_GH_FIXTURE, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "list") {
  if (fixture.listError) {
    process.stderr.write(fixture.listError);
    process.exit(1);
  }
  console.log(JSON.stringify(fixture.list));
} else if (args[0] === "issue" && args[1] === "view") {
  const number = args[2];
  const issue = fixture.views?.[number] ?? fixture.list.find((candidate) => String(candidate.number) === number);
  if (!issue) {
    process.stderr.write("issue not found: " + number);
    process.exit(1);
  }
  console.log(JSON.stringify(issue));
} else {
  process.stderr.write("unexpected gh command: " + args.join(" "));
  process.exit(1);
}
`,
  );
  chmodSync(ghPath, 0o755);

  const originalPath = process.env.PATH;
  const originalFixture = process.env.HARNESS_GH_FIXTURE;
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
  process.env.HARNESS_GH_FIXTURE = fixturePath;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalFixture == null) delete process.env.HARNESS_GH_FIXTURE;
    else process.env.HARNESS_GH_FIXTURE = originalFixture;
    rmSync(dir, { recursive: true, force: true });
  });
}

function issue(
  number: number,
  overrides: {
    blockedBy?: RawReference[];
    subIssues?: RawReference[];
    assignees?: string[];
    parent?: RawReference | null;
  } = {},
): RawIssue {
  const subIssues = overrides.subIssues ?? [];
  const completed = subIssues.filter((child) => child.state === "CLOSED").length;
  return {
    number,
    title: `Issue ${number}`,
    url: `https://example.test/issues/${number}`,
    updatedAt: "2026-07-25T00:00:00Z",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }],
    blockedBy: {
      nodes: overrides.blockedBy ?? [],
      totalCount: overrides.blockedBy?.length ?? 0,
    },
    subIssues: { nodes: subIssues, totalCount: subIssues.length },
    subIssuesSummary: {
      completed,
      percentCompleted: subIssues.length === 0 ? 0 : (completed / subIssues.length) * 100,
      total: subIssues.length,
    },
    assignees: (overrides.assignees ?? []).map((login) => ({ login })),
    parent: overrides.parent ?? null,
  };
}

function reference(number: number, state = "OPEN"): RawReference {
  return { number, title: `Issue ${number}`, state };
}
