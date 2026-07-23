# github-agent-harness

Single-task, merge-gated coding harness.

```text
Picker → Ledger Claim → Orca Worktree → Codex $implement
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
4. If **blocked** → sleep and hold the slot; only a completed audit wait with a known decision/timeout error, current result, and clean tracked tree resumes through the audit gate
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
| awaiting_audit / auditing / reworking | `audit-once` (reuse audit JSON if HEAD matches) |
| audit_passed / publishing | `publish-once` (reuse existing PR) |
| awaiting_merge | `wait-merge` |
| blocked after eligible audit wait | `audit-once` (evaluate the existing result through the normal gate) |
| other blocked | nothing — hold the slot |
| merged / no active job | nothing — safe to pick next |

Recovery never accepts an audit result directly; eligible interrupted audits re-enter `audit-once` so the normal SHA, cleanliness, validation, and finding gates still run.

Invariants: no double claim, no double worktree, no double PR, no skip audit, no next issue until merged.

### Dispatch acceptance (anti “agent 没反应”)

Before dispatch, harness requires `tui-idle`. After every `orchestration dispatch --inject`, it probes the agent terminal (~45s) for:

- the exact task id in retained output
- fresh cursor output showing the worker preamble / Working
- TUI leaving idle

Confirmed silent-idle or provider/model startup failures **fail the old task, recreate the agent terminal once, and re-dispatch**. Interactive gates and unavailable/ambiguous probes are not retried automatically; their dispatch provenance stays in the ledger so `recover` can resume safely. Used by implement, audit, and rework paths.

Config: `config/harness.yaml`.

### Agent profiles

Implementer and auditor are **roles** bound to **profiles** (Codex, Pi+provider A, Pi+provider B…).

```yaml
activeProfiles:
  implementer: codex-default   # swap later to a pi-* profile
  auditor: pi-reviewer
```

V1 only runs the implementer path end-to-end.

## Hard rules (V1)

1. Agents never mutate GitHub labels.
2. Global max 1 in-flight issue until merged/cancelled.
3. Codex and Pi never write the same worktree concurrently.
4. No PR before Pi pass.
5. No next claim before PR merge.
6. Closed-unmerged / audit exhausted / issue revoked → block, do not skip ahead.
7. No auto-merge.

## Orca role

Orca is the only execution layer:

- worktree / terminal / dispatch / `worker_done`
- process monitoring via `worktree ps`, `terminal read`, task list, UI comments

Business state lives in the harness SQLite ledger (from M2).
