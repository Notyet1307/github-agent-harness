# github-agent-harness

[简体中文](README.zh-CN.md)

A single-task coding-agent controller with a merge gate.

```text
Picker → Ledger Claim → Orca Worktree → Pi /skill:implement
  → Pi dual-axis audit → Gate → PR → Human merge → Next
```

## Overview

The harness selects work from GitHub issues, uses a SQLite ledger to allow only
one in-flight job globally, and asks Orca to create an isolated worktree and
dispatch the Pi implementer and Pi auditor. The controller pushes a branch and
opens a PR only after an independent audit passes. The harness never merges;
an external human action performs the merge after all applicable branch
protection requirements are satisfied.

| Milestone | Command | Status |
|---|---|---|
| M0 | `pnpm harness doctor` | Implemented: configuration and runtime checks |
| M1 | `pnpm harness pick --dry-run` | Implemented: read-only picker preview |
| M2 | `pnpm harness run-once` | Implemented: stops after implementation commits |
| M3 | `pnpm harness audit-once` | Implemented: Pi two-axis audit and rework gate, no PR |
| M4 | `pnpm harness publish-once` / `wait-merge` | Implemented: create PR and wait for human merge |
| M5 | `pnpm harness recover` | Implemented: reconcile and resume one ensure step |
| M6 | `pnpm harness watch` | Implemented: foreground polling controller, never auto-merges |
| Deployment | macOS `launchd` | Deferred: this repository has no plist or service commands |

## Quick start

Requires Node.js 20+, pnpm, an authenticated `gh`, a ready Orca runtime, and
the Pi resources required by the configuration.

```bash
cd ~/github-agent-harness
pnpm install
pnpm harness doctor
pnpm harness pick --dry-run
pnpm test
```

The main configuration is
[`config/harness.yaml`](config/harness.yaml). Before real work, require a
passing `doctor` result and use the dry-run picker to verify the issue that
would be claimed.

## Wayfinder Map selection

A ready-labeled issue with GitHub sub-issues is a Wayfinder Map container, not
an executable task. The picker keeps top-level issues ordered by issue number,
but replaces each Map with at most one frontier child selected in the original
GitHub sub-issue order. A child must be open, carry `issueLabel`, have no open
blocker or assignee, and not already be in the ledger. Parented children are
considered only through their Map, so issue-number sorting cannot bypass Map
order.

The Map and executable children must be present in the ready-labeled snapshot.
An open child encountered before a winner but missing the ready label closes
that Map's frontier for the poll; incomplete, conflicting, or nested topology
also fails closed. A Map with no frontier does not block an unrelated
standalone issue or later Map.

This support is selection-only: the controller does not add assignees, mutate
labels, resolve children, or close a completed Map. `run-once --issue N` asserts
that `N` is the current picker winner; it never overrides Map order or gates.
Only one Map level and native GitHub sub-issues are supported; task-list body
fallbacks and nested Maps are out of scope.

## Operating modes

### Manual one-shot commands

Each command has an explicit stopping point; no one command is the entire
pipeline.

| Command | Description |
|---|---|
| `pnpm harness run-once` | Claim an issue, create or reuse the worktree, and finish implementation; no push or PR |
| `pnpm harness audit-once` | Run the independent Pi audit and controlled rework when needed; no PR |
| `pnpm harness publish-once` | Push and create or reuse the PR after audit passes, then stop at `awaiting_merge` |
| `pnpm harness wait-merge --timeout-minutes 60` | Poll GitHub merge state only; never perform the merge |
| `pnpm harness recover --dry-run` | Show the ensure step that should resume after a crash, without changing state |
| `pnpm harness recover --execute` | Execute the reconciled recovery step |
| `pnpm harness status` | Show the active job, recent jobs, and Orca state |

### Foreground watch

> **Warning: `watch` is an active controller, not a passive merge monitor.**
> With no active job, it claims the next eligible labeled issue, dispatches
> agents, runs the audit, and pushes and creates a PR in later cycles.

```bash
pnpm harness watch
pnpm harness watch --once
pnpm harness watch --dry-run --once
pnpm harness watch --max-cycles 10 --poll-seconds 30
```

Today `watch` runs only as a foreground process; monitoring stops when its
terminal or process exits. The default interval comes from
`pollIntervalSeconds` (currently 120 seconds). `SIGINT` and `SIGTERM` stop it
after the current cycle.

Each cycle:

1. Reconcile the active job from the same evidence used by `recover`.
2. With an active job, resume one ensure step: `run-once`, `audit-once`,
   `publish-once`, or one `wait-merge` poll.
3. With no active job, try to claim and implement the next eligible issue; if
   implementation finishes in that cycle, chain one audit immediately.
4. After a human merges the PR, the next poll records `mergedAt` and frees the
   single ledger slot, while retaining the Orca worktree for inspection.
5. A `blocked` job keeps the slot. CI failures or requested changes do not
   automatically trigger rework while waiting for merge.
6. Never auto-merge and never auto-delete completed worktrees.

### launchd service (deferred)

This repository currently has **no** launchd plist and no
install/start/status/uninstall service commands, and it does not install or
start a persistent watcher. Use foreground `pnpm harness watch` until the
production repository enables the service.

Before launchd is enabled, the production repository must at minimum:

- Pin the Node executable, repository working directory, and built CLI path.
- Provide `HOME` and a stable `PATH` so `gh`, `git`, `orca`, and `pi` resolve.
- Run `doctor` before loading, configure stdout/stderr logs, and verify
  single-instance and uninstall behavior.
- Before enabling login startup and crash restart, verify that `bootout` exits
  promptly during the synchronous poll sleep; current signal handling may be
  delayed by up to one poll interval.
- Never run alongside a manually started foreground watcher, never store
  tokens in the plist, and define log rotation.
- Explicitly inherit the full `watch` behavior above: it will auto-claim new
  issues, but will not auto-merge or delete worktrees.

## Recovery and reliability

After a controller crash, do not claim a new issue directly. Run:

```bash
pnpm harness recover --dry-run
pnpm harness recover --execute
```

| Ledger state | Resume action |
|---|---|
| `claimed` / `worktree_ready` / `implementing` | `run-once`: reuse the worktree; verify and finalize existing commits without re-waiting |
| `awaiting_audit` / `auditing` / `reworking` | `audit-once`: reuse only same-round, exact-SHA results with complete provenance |
| `audit_passed` / `publishing` | `publish-once`: find and reuse the PR by head |
| `awaiting_merge` | `wait-merge`: poll and record the result only |
| Recoverable blocked audit | `audit-once`: re-enter the normal gate |
| Ended implementation with no commits | Redispatch in the same worktree only through explicit `recover --execute` |
| Other `blocked` | Stop and keep the slot |
| `merged` / no active job | Safe to claim the next issue |

Never edit the ledger by hand or use an ad-hoc script to accept
`.harness/audit-result.json`. Audits must re-enter the strict gate through
`audit-once` or `recover --execute`.

Before claiming, `run-once` refreshes the configured remote-tracking `baseRef`,
pins its full SHA, and requires the Orca worktree HEAD to match exactly. It
requires an idle TUI before dispatch and probes for the task id or fresh Working
signals afterward. A `worker_done` message must match the current task and the
recorded dispatch id.

## Active Pi roles

```yaml
activeProfiles:
  implementer: pi-implementer
  auditor: pi-reviewer
```

| Role | Profile | Permissions and responsibility |
|---|---|---|
| Implementer | `pi-implementer` | Uses `read,edit,write,bash,subagent` for implementation, tests, commits, rework, and isolated internal two-axis review |
| Auditor parent | `pi-reviewer` | Must not modify tracked files or HEAD; may write the sole gate artifact `.harness/audit-result.json` |
| Internal reviewer | `harness-reviewer` | Fresh user scope, no artifacts, returns only a Standards or Spec report to its parent |

The implementer explicitly loads controller-owned Matt `implement` and `tdd`
pinned to
[`ed37663`](https://github.com/mattpocock/skills/tree/ed37663cc5fbef691ddfecd080dff42f7e7e350d),
plus the Pi-adapted `code-review`. It loads only Orca prefill/status and the
approved `pi-subagents` version; ReadSeek is not loaded. Automatic skill,
extension, prompt-template, and project Pi resource discovery are disabled,
while repository `AGENTS.md` / `CLAUDE.md` context remains enabled.

The implementer and auditor still share the parent Pi provider/model and
`PI_CODING_AGENT_DIR`; role-level provider/config isolation remains deferred.
Internal reviewers use a wrapper that removes the parent's Orca lifecycle
handles.

> Pi's tool allowlist is **not an OS sandbox**. In particular, `bash` and
> TypeScript extensions retain the Pi process's filesystem, credential, and
> network access. Real isolation must be enforced outside Pi.

## Hard rules

1. Agents never create, add, or remove GitHub labels.
2. At most one issue may be in flight globally; only merge or explicit
   cancellation frees the slot.
3. Only the implementer may modify tracked product files; the auditor may write
   only the gate artifact.
4. No PR may be created before the independent Pi audit passes.
5. Do not claim the next issue before the PR is merged.
6. Closed-unmerged, audit-exhausted, or revoked issues must block; never skip
   ahead.
7. Never auto-merge and never auto-delete completed worktrees.

## Configuration, state, and decisions

- Configuration: [`config/harness.yaml`](config/harness.yaml)
- Business state: `data/harness.sqlite`
- Runtime logs: controller foreground output and Orca terminals
- Architecture decisions: [`docs/decisions.md`](docs/decisions.md)

Orca is the sole execution layer for worktrees, terminals, dispatches, tasks,
and `worker_done`; the SQLite ledger is authoritative for business state.
