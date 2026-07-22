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

## Deferred — multiple Pi profiles by role

**Status:** not building now; keep the seam open.

Intent:

- Implementer and auditor may both be Pi, but **different profiles**:
  - different providers / models
  - different `PI_CONFIG_DIR` or extension sets
  - different invoke skills
- Possibly more than two roles later (e.g. rework-only, docs-only).

Already supported by design (do not collapse later):

- `agentProfiles` + `activeProfiles.implementer|auditor` in `config/harness.yaml`
- `AgentProfile.command` / `env` fields on the type
- Roles in the state machine (`implementing` / `auditing` / `reworking`), not brand names

When implementing later:

1. Add concrete profiles (e.g. `pi-implementer-a`, `pi-auditor-b`) with isolated env/config dirs.
2. Point `activeProfiles` at them; no state-machine rewrite.
3. Keep **one writer per worktree**; auditor stays readonly + tracked-clean check.
4. Prefer different models/providers for implementer vs auditor when both are Pi.

Do **not** hardcode Codex/Pi in transition logic.

## 2026-07-22 — M4 publish

| Decision | Choice | Why |
|---|---|---|
| Publisher | Controller only (`publish-once`) | Agents never create PRs |
| Merge | Wait only, no auto-merge | Human / branch protection |
| CI / changes requested while waiting | Record `last_error`, stay `awaiting_merge` | V1 does not auto-rework from wait loop |
| After merge | State `merged`, Orca card `completed`, keep worktree | Inspect before delete |
| Next claim | Only when job is `merged` or `cancelled` | Single-slot rule |

## 2026-07-22 — M5 recovery

| Decision | Choice | Why |
|---|---|---|
| Entry command | `harness recover` dry-run default, `--execute` to act | Safe after crash |
| Routing | Pure `reconcileJob` → ensure* command | Testable without Orca |
| Codex done / ledger stale | Commits since base ⇒ finalize without worker_done | Crash after implement |
| Pi done / ledger stale | Reuse `.harness/audit-result.json` if HEAD matches | Crash after audit write |
| PR create | Always find-by-head before create | No duplicate PR |
| Worktree | Reuse by issue linkage / path | No duplicate worktree |
| Tests | Unit matrix + ledger single-slot | Cheap regression without full agent |
