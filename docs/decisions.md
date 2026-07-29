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
The `codex-default` choice above was superseded by the 2026-07-23 Pi
implementer decision; it remains available only as an explicit rollback.

## 2026-07-22 — M3 audit

| Decision | Choice | Why |
|---|---|---|
| Pi subagent source | User global `npm:pi-subagents` (`nicobailon/pi-subagents`) | Supports explicit user-scope discovery and child resource policy |
| Auditor resources | Controller-owned launcher, skill, and `harness-reviewer` | Project agents/settings cannot redefine the independent reviewer |
| Auditor model | Inherit the active parent Pi provider/model | Child receives the resolved parent model; pin in the launcher only if a gateway requires it |
| Gate input | Runtime-validated `.harness/audit-result.json` with full exact SHAs and validation evidence | Natural-language worker_done and TypeScript casts are not machine-safe |
| Smells | Non-blocking alone | Matches Matt dual-axis semantics |
| Rework fixed point | Before a new/retry dispatch require the exact `audit_head_sha` with tracked files clean; accept completion only as a clean tracked descendant commit | Do not treat original implementation commits, dirty tracked changes, or rewritten history as rework |
| M3 stop state | `audit_passed` | No PR until M4 |

## 2026-07-23 — Pi implementer

| Decision | Choice | Why |
|---|---|---|
| Active implementer | `pi-implementer` | Use Pi for both initial implementation and rework without changing role/state transitions |
| Parent tools | `read,edit,write,bash,subagent` | Minimum surface that can implement, validate, commit, and run the required internal review |
| Skills | Verbatim Matt `implement` / `tdd` at `ed37663`, plus a Pi adapter of Matt `code-review` | Preserve the approved workflow while replacing its unavailable `Agent` orchestration |
| Extensions | Orca prefill/status and the existing pinned `pi-subagents` install | Lifecycle visibility plus two isolated internal review axes; no UI-only extension |
| Internal reviewer | Reuse controller-owned `harness-reviewer`, user scope, fresh context, no artifacts; launch children through an env-scrubbing wrapper | Avoid duplicate agents and keep Orca lifecycle credentials in the parent |
| Project resources | `--no-approve`, automatic skills/extensions/templates disabled | Target repositories cannot redefine the worker role or tool surface |
| ReadSeek | Not loaded | Pi built-in edit/write are sufficient for the baseline; avoid extra write/rename tools and project settings |
| Security boundary | External to Pi | `--tools` is not a filesystem/network sandbox, especially with `bash` and TypeScript extensions |

The inactive `codex-default` profile remains as an explicit rollback option.
Provider/model and `PI_CODING_AGENT_DIR` isolation between Pi roles remains
deferred; both launchers currently use the configured parent Pi environment.

## Deferred — multiple Pi profiles by role

**Status:** provider/model/config-directory isolation is not built; keep the seam open.

Intent:

- Implementer and auditor may both be Pi, but **different profiles**:
  - different providers / models
  - different `PI_CODING_AGENT_DIR` or extension sets
  - different invoke skills
- Possibly more than two roles later (e.g. rework-only, docs-only).

Already supported by design (do not collapse later):

- `agentProfiles` + `activeProfiles.implementer|auditor` in `config/harness.yaml`
- `AgentProfile.command` / `env` fields on the type
- Roles in the state machine (`implementing` / `auditing` / `reworking`), not brand names

When implementing later:

1. Add concrete profiles (e.g. `pi-implementer-a`, `pi-auditor-b`) with isolated env/config dirs.
2. Point `activeProfiles` at them; no state-machine rewrite.
3. Keep **one tracked-code writer per worktree**; the auditor may write only
   the gate artifact and must leave tracked files and HEAD unchanged.
4. Prefer different models/providers for implementer vs auditor when both are Pi.

Do **not** hardcode Codex/Pi in transition logic.

## 2026-07-23 — claim base freshness

| Decision | Choice | Why |
|---|---|---|
| Base refresh | Fetch the configured remote-tracking `baseRef` before GitHub selection | A locally stale `origin/main` must not seed a new job |
| Fixed point | Store the refreshed full SHA at claim and compare the created worktree HEAD exactly | Detect an Orca/ref race before agent dispatch |
| Refresh failure | Fail closed without claiming; a resumed pre-worktree job remains claimed and retryable | Network/ref failures are infrastructure failures, not code work |
| Audit finalization | Only `recover` / `audit-once`; remove the ad-hoc ledger finalizer | Preserve same-round task provenance and the normal audit gate |

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
| Codex done / ledger stale | Exact Orca task `completed` plus commits since base ⇒ finalize without `worker_done` | Recover a lost completion message without advancing live or failed work |
| Pi done / ledger stale | Reuse only a valid result for the exact base/HEAD when the same-round auditor task is completed | Crash recovery without accepting stale files |
| Git lineage | Before implementation finalization, audit/rework, or publish, require the pinned `base_sha` to be an ancestor of the current HEAD; divergence or Git verification errors block | `base_sha..HEAD` can contain commits even when HEAD is on a sibling history |
| Blocked audit wait | Known decision/timeout error + auditor task completed + current result + tracked clean ⇒ re-enter audit gate | Recover late evidence without accepting it directly |
| PR create | Always find-by-head before create | No duplicate PR |
| Worktree | Reuse by issue linkage / path | No duplicate worktree |
| Tests | Unit matrix + ledger single-slot | Cheap regression without full agent |

## 2026-07-22 — M6 watch

| Decision | Choice | Why |
|---|---|---|
| Default loop | `harness watch` | Avoid manual wait-merge / recover |
| One ensure* step per cycle | Yes (except implement→audit chain) | Simpler failure isolation |
| Auto-merge | Never | Human / branch protection |
| Blocked job | Sleep; hold slot, except the evidence-complete audit-wait recovery above | Do not skip to next issue |
| Poll interval | `pollIntervalSeconds` (default 120) | Config-driven |
| launchd | Not yet | Start with foreground watch first |

## 2026-07-23 — launchd deployment remains deferred

| Decision | Choice | Why |
|---|---|---|
| Current state | Documentation only; the repository ships no plist or lifecycle commands | Do not imply a service exists before its lifecycle is tested |
| Deployment target | Enable only in the later production repository | This controller remains an actively changing harness |
| Current operation | Foreground `harness watch` | Existing behavior is implemented and observable |
| Future service behavior | Run the full active watch loop | A daemon would auto-claim eligible issues as well as record merges; it is not a passive merge monitor |
| Merge and cleanup | No auto-merge; mark the ledger job `merged`, free the slot, retain the worktree | Preserve current safety and inspection policy |
| Environment gate | User LaunchAgent with pinned Node/repo/config paths, explicit `HOME`/stable `PATH`, logs, `doctor`, single-instance, and uninstall checks | launchd does not inherit the interactive shell environment |
| Shutdown gate | Verify or replace the synchronous poll sleep before relying on graceful `bootout` | `SIGTERM` handling can currently wait up to one poll interval while `spawnSync` blocks |

## 2026-07-28 — M7 GitHub auto-merge

| Decision | Choice | Why |
|---|---|---|
| Default policy | `wait` | Existing repositories retain human merge until explicitly opted in |
| Auto action | Invoke `gh pr merge --auto --match-head-commit --merge`, never an explicit direct-merge API | Reuse GitHub's native CI/review gate and SHA check; `--merge` makes the native CLI non-interactive |
| Preconditions | Applied branch rule has required status checks; PR head exactly matches the audited head; GitHub reports `CLEAN` | No green-by-absence inference and no merge of a post-audit commit |
| Request timing | Invoke `--auto --match-head-commit` only at `CLEAN` | The GitHub CLI may complete the matched merge immediately; do not leave a persistent request while CI or review is unresolved |
| Unsafe PR state | Disable an existing auto-merge request on CI failure, requested changes, or a changed head | Retain the job for explicit recovery; never merge a post-audit commit |
| Missing rule/head mismatch | Disable any existing auto-merge request, then block and retain the single-job slot | Fail closed; never skip to another issue |
| Auto-merge request error | Record error and retain `awaiting_merge` | Repository settings or temporary GitHub errors can be corrected without losing the PR |

## 2026-07-22 — dispatch acceptance probe

| Decision | Choice | Why |
|---|---|---|
| After `dispatch --inject` | Probe TUI ≤45s for acceptance signals | Catch silent idle (Pi/Codex “没反应”) |
| Strong signals | exact task id / fresh worker preamble or Working / non-idle | Avoid stale terminal history false positives |
| Confirmed silent failure | Fail old task, recreate terminal, re-dispatch once | Recover dropped inject without duplicate active tasks |
| Provider/model startup failure | Treat like confirmed silent failure | Infrastructure failure is retryable, not a code failure |
| Interactive or unknown probe | Preserve provenance; do not auto retry | Avoid duplicate work while human action or probe recovery may unblock it |
| Max attempts | 2 | Avoid infinite loops |

## 2026-07-23 — worker completion provenance

| Decision | Choice | Why |
|---|---|---|
| Completion matching | Parse string/object payloads, require the current task id plus the recorded dispatch id, and reject new dispatches with no id | Persistent controller inboxes can contain stale messages; missing provenance is not proof of completion |
| Internal review subagents | No inherited Orca context; reports return only to the parent implementer | A reviewer must not be able to complete its parent's lifecycle task |
| Late implementation commit | Only for the exact recorded Orca task in `completed`, verify and finalize existing commits without redispatch | Git can recover a lost `worker_done`, but must not outrun live, failed, missing, or unreadable task state |
| Late rework commit | Only for the exact recorded Orca task in `completed`, verify a clean descendant of the exact audited HEAD and re-audit without redispatch | Rework commits can survive a lost `worker_done`; stale or divergent Git/task state still blocks |
| Escalation | Always block even when valid commits exist | Explicit worker requests must not be hidden by Git fallback |
| Implementer terminal recovery | Reuse only one connected exact role-title match; otherwise create a fresh terminal before a new or pending dispatch | Orca restarts invalidate handles, while fuzzy or ambiguous matches can target another session |
| No-commit completion recovery | Require readable HEAD at the pinned base; preserve the worktree and redispatch only via explicit `recover --execute` | Keep partial changes without letting failed retries or `watch` create retry loops |
| Timed-out zero-commit rework | Redispatch only through explicit `recover --execute` after the exact stale task is `failed`; require its dispatch provenance, the exact clean audited HEAD, current audit artifact, and pinned-base ancestry | Recover a dead rework worker without treating original implementation commits as rework or allowing `watch` retry loops |

## 2026-07-25 — Wayfinder Map frontier selection

| Decision | Choice | Why |
|---|---|---|
| Scope | Selection-only, one native GitHub sub-issue level | Fix Map mis-selection without adding a second GitHub lifecycle controller |
| Map identity | A ready issue with sub-issues is a container and is never claimed | Parent specs coordinate work; children are executable tickets |
| Ordering | Top-level issue number, then native sub-issue order within each Map | Preserve existing repository ordering while honoring Wayfinder map order |
| Frontier gate | OPEN child with the ready label, no open blocker, no assignee, and no ledger entry | Combine the controller's authorization label with Wayfinder availability rules |
| Parented children | Consider only through the owning Map | Prevent issue-number sorting or `--issue` from bypassing Map order |
| Missing or conflicting topology | Fail the affected Map closed; continue unrelated top-level candidates | Do not guess through incomplete relationships or block independent work |
| GitHub mutations | No automatic assign, label changes, child resolution, or Map close | SQLite remains the controller claim source; humans own tracker lifecycle |
| Unsupported | Nested Maps and task-list body fallbacks | Keep the first implementation bounded to the verified native sub-issue shape |
