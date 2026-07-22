# Decisions

## 2026-07-22 — Kickoff

| Decision | Choice | Why |
|---|---|---|
| First target repo | `Notyet1307/harness-sandbox` | Dedicated sandbox; fail cheap |
| Harness location | `/Users/yang/github-agent-harness` | Central controller, not inside business repos |
| Execution layer | Orca only (V1) | Native worktree/terminal/orchestration + UI monitoring |
| Merge policy | Wait for human/branch protection; no auto-merge | Safer V1 |
| Concurrency | Global single job until merged/cancelled | Simplest recovery model |
| Labels | Read-only `ready-for-agent`; agents never mutate labels | Avoid GitHub state thrash |

## Orca monitoring (feasible)

Use Orca as process surface, not only launcher:

| Need | Command / surface |
|---|---|
| Cross-worktree summary | `orca worktree ps --json` |
| Card status in UI | `orca worktree set --workspace-status ... --comment "..."` |
| Live agent output | `orca terminal list/show/read` |
| Task/dispatch provenance | `orca orchestration task-list / dispatch-show / inbox` |
| Runtime health | `orca status --json`, `orca diagnostics memory` |
| UI inspection | Orca app + `orca computer` if needed |

Controller owns business state (SQLite ledger). Orca owns runtime visibility.

## 2026-07-22 — M2 + multi-agent profiles

| Decision | Choice | Why |
|---|---|---|
| M2 on #1 | Real `run-once` | Sandbox exists to burn real runs |
| Harness git | Local commit, no push | Checkpoint without remote ceremony |
| Monitoring | worktree comment + `harness status` | Enough for V1 UI + CLI ops |
| Implementer | Profile `codex-default` (swap later) | Roles stable; brands are config |
| Auditor | Profile `pi-reviewer` reserved | M3; supports alternate Pi provider dirs later |

Implementer/auditor are **roles**. Codex vs Pi(+provider/extensions) are **profiles** under `agentProfiles` + `activeProfiles`.

## 2026-07-22 — M3 audit

| Decision | Choice | Why |
|---|---|---|
| Pi subagent source | User global `npm:pi-sub-agent` | Project copy conflicts with global tool name |
| Auditor model | `pi --provider baizhi-responses --model feature/gpt` | Default sol hits baizhi “Codex version too low” |
| Gate input | `.harness/audit-result.json` schema | Natural-language worker_done is not machine-safe |
| Smells | Non-blocking alone | Matches Matt dual-axis semantics |
| M3 stop state | `audit_passed` | No PR until M4 |
