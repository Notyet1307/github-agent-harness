# github-agent-harness

Single-task, merge-gated coding harness.

```text
Picker → Ledger Claim → Orca Worktree → Pi /skill:implement
  → Pi dual-axis audit → Gate → PR → Wait merge → Next
```

## Status

| Milestone | Command | State |
|---|---|---|
| M0 | `pnpm harness doctor` | implemented |
| M1 | `pnpm harness pick --dry-run` | implemented |
| M2 | `pnpm harness run-once` | implemented (stop after implement commits) |
| M3 | `pnpm harness audit-once` | implemented (Pi dual-axis gate + rework; no PR) |
| M4 | `pnpm harness publish-once` / `wait-merge` | implemented (push+PR; no auto-merge) |
| M5 | `pnpm harness recover` | implemented (reconcile + ensure* resume) |
| M6 | `pnpm harness watch` | implemented (poll loop; no auto-merge) |

## Setup

```bash
cd ~/github-agent-harness
pnpm install
pnpm harness doctor
pnpm harness pick --dry-run
pnpm harness run-once          # claim + Orca worktree + implementer; no push/PR
pnpm harness audit-once        # Pi dual-axis audit gate (+ rework loop); no PR
pnpm harness publish-once      # push + create PR; stop at awaiting_merge
pnpm harness wait-merge --timeout-minutes 60
pnpm harness recover --dry-run    # M5: what to resume after crash
pnpm harness recover --execute    # M5: run the ensure* step
pnpm harness watch --dry-run --once   # M6: one poll cycle, no side effects
pnpm harness watch                # M6: continuous (Ctrl+C to stop)
pnpm harness status
pnpm test
```

Before a new claim, `run-once` refreshes the configured remote-tracking
`baseRef`, stores its full SHA in the ledger, and requires the Orca-created
worktree HEAD to match exactly. Fetch or SHA mismatches fail closed before
dispatch.

### Watch (M6)

```bash
pnpm harness watch                 # poll forever (config pollIntervalSeconds)
pnpm harness watch --once          # single cycle
pnpm harness watch --dry-run --once
pnpm harness watch --max-cycles 10 --poll-seconds 30
```

Each cycle:

1. Reconcile active job (same as recover)
2. If active → resume one ensure* step (`run-once` / `audit-once` / `publish-once` / `wait-merge` poll)
3. If none → `run-once` to claim next ready issue (if any)
4. If **blocked** → sleep and hold the slot; completed evidence may resume finalization, while implementation redispatch requires an explicit `recover --execute`
5. Never auto-merges — you merge on GitHub; watch records `mergedAt`

### Crash recovery (M5)

After controller crash, **do not claim a new issue**. Run:

```bash
pnpm harness recover --dry-run
pnpm harness recover --execute
```

Routing (ensure*, not blind create):

| State | Resume |
|---|---|
| claimed / worktree_ready / implementing | `run-once` (reuse worktree; commits skip re-wait) |
| awaiting_audit / auditing / reworking | `audit-once` (reuse only valid exact-SHA JSON from a completed same-round task) |
| audit_passed / publishing | `publish-once` (reuse existing PR) |
| awaiting_merge | `wait-merge` |
| blocked after implementation commits landed late | `run-once` (verify and finalize without redispatch) |
| blocked after an ended implementation with no commits | explicit `recover --execute` redispatches the same issue in the existing worktree |
| blocked after eligible audit wait | `audit-once` (evaluate the existing result through the normal gate) |
| other blocked | nothing — hold the slot |
| merged / no active job | nothing — safe to pick next |

Recovery never accepts an audit result directly; eligible interrupted audits re-enter `audit-once` so strict structure, exact full-SHA, same-round task provenance, cleanliness, validation, and finding gates still run.
Implementation retries require a readable worktree still at the pinned base, clear stale task/dispatch provenance, and preserve tracked changes. A failed retry remains blocked; `watch` never triggers another retry automatically.

Do not finalize an audit by editing the ledger or evaluating
`.harness/audit-result.json` from an ad-hoc script. `recover --execute` and
`audit-once` are the only supported audit-finalization paths.

Invariants: no double claim, no double worktree, no double PR, no skip audit, no next issue until merged.

### Dispatch acceptance (anti “agent 没反应”)

Before dispatch, harness requires `tui-idle`. After every `orchestration dispatch --inject`, it probes the agent terminal (~45s) for:

- the exact task id in retained output
- fresh cursor output showing the worker preamble / Working
- TUI leaving idle

Confirmed silent-idle or provider/model startup failures **fail the old task, recreate the agent terminal once, and re-dispatch**. Interactive gates and unavailable/ambiguous probes are not retried automatically; their dispatch provenance stays in the ledger so `recover` can resume safely. Used by implement, audit, and rework paths.

Completion messages are accepted only after parsing the Orca payload and matching the current task id plus the dispatch id when one was recorded. New dispatches without an id fail closed; stale, malformed, or provenance-free `worker_done` messages are ignored.

Implementation and rework prompts also isolate internal review subagents from Orca lifecycle credentials. Only the parent implementer may send `worker_done`.

Config: `config/harness.yaml`.

### Agent profiles

Implementer and auditor are **roles** bound to **profiles** (Codex, Pi+provider A, Pi+provider B…).

```yaml
activeProfiles:
  implementer: pi-implementer
  auditor: pi-reviewer
```

The implementer launcher enables only:

- built-in tools: `read`, `edit`, `write`, `bash`
- extension tool: `subagent`
- controller-owned Matt `implement` and `tdd` skills pinned to
  [`ed37663`](https://github.com/mattpocock/skills/tree/ed37663cc5fbef691ddfecd080dff42f7e7e350d),
  plus the controller-owned Pi `code-review` adapter
- Orca prefill/status extensions and the installed `pi-subagents` extension

It disables automatic skill, extension, prompt-template, and project Pi
resource loading. Repository `AGENTS.md` / `CLAUDE.md` context remains enabled.
ReadSeek is intentionally not loaded. Internal reviewer children use a wrapper
that removes the parent Orca lifecycle handles before Pi starts.

The tool allowlist is not an OS sandbox: `bash` and extensions still run with
the permissions of the Orca-launched Pi process. Filesystem, credential, and
network isolation must be enforced outside Pi.

## Hard rules (V1)

1. Agents never mutate GitHub labels.
2. Global max 1 in-flight issue until merged/cancelled.
3. Only the implementer writes the worktree; the auditor stays read-only.
4. No PR before Pi pass.
5. No next claim before PR merge.
6. Closed-unmerged / audit exhausted / issue revoked → block, do not skip ahead.
7. No auto-merge.

## Orca role

Orca is the only execution layer:

- worktree / terminal / dispatch / `worker_done`
- process monitoring via `worktree ps`, `terminal read`, task list, UI comments

Business state lives in the harness SQLite ledger (from M2).
