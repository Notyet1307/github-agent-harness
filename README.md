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
| M3+ | Pi audit / PR / merge wait | not yet |

## Setup

```bash
cd ~/github-agent-harness
pnpm install
pnpm harness doctor
pnpm harness pick --dry-run
pnpm harness run-once          # claim + Orca worktree + implementer; no push/PR
pnpm harness status
```

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
