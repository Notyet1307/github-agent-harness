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
| New machine onboarding | `pnpm harness setup` | Implemented: idempotent Git, GitHub, config, and Orca enrollment |
| M1 | `pnpm harness pick --dry-run` | Implemented: read-only picker preview |
| M2 | `pnpm harness run-once` | Implemented: stops after implementation commits |
| M3 | `pnpm harness audit-once` | Implemented: Pi two-axis audit and rework gate, no PR |
| M4 | `pnpm harness publish-once` / `wait-merge` | Implemented: create PR and wait for human merge |
| M5 | `pnpm harness recover` | Implemented: reconcile and resume one ensure step |
| M6 | `pnpm harness watch` | Implemented: foreground polling controller, never auto-merges |
| Deployment | macOS `launchd` | Deferred: this repository has no plist or service commands |

## New machine onboarding

The onboarding boundary is deliberate: GitHub identity and policy are tracked,
while paths, Orca ids, the SQLite ledger, extensions, and credentials remain
machine-local. A new computer must recreate those local bindings; it should not
copy another computer's ledger or edit absolute paths into YAML.

### What `setup` automates

`pnpm harness setup --repo OWNER/REPO --path /absolute/path/to/repo` is the
primary onboarding command. It:

1. Validates that the path is an absolute, readable Git worktree.
2. Verifies that every `origin` fetch/push URL identifies `OWNER/REPO`.
3. Discovers or validates the GitHub default branch and `origin/...` base ref.
4. Registers or reuses both the Harness repo and target repo in Orca.
5. Sets the target Orca repo's worktree base ref.
6. Writes only the portable repository entry to `config/harness.yaml` when
   needed, preserving unrelated YAML and file permissions.
7. Runs `doctor` after a successful real setup.

Setup does **not** clone repositories, install or authenticate external tools,
create GitHub labels, copy provider credentials, provision Orca-managed Pi
extensions, claim an issue, create a worktree, or merge a PR. A real setup is
refused while the local ledger has an active job.

### 1. Prepare machine-local prerequisites

| Dependency | Requirement | Check |
|---|---|---|
| Node.js | 22.19 or newer | `node --version` |
| pnpm | Exactly 10.26.1, as declared by `packageManager` | `pnpm --version` |
| Git | Able to clone, fetch, and push the target repo | `git --version` |
| GitHub CLI | Authenticated with issue, branch, and PR access | `gh auth status` |
| Orca | App running and CLI runtime ready | `orca status` |
| Pi user scope | Provider/model configured; Orca Pi extensions generated | Initialize after dependency install; verify with `doctor` |

`pnpm install` provides the pinned Pi CLI and `pi-subagents`; no global Pi
installation is required. Harness-owned skills, prompts, launchers, and auditor
definitions live in this repository. Provider credentials and Orca-generated
Pi extensions stay in the user's Pi directory and are never committed.

### 2. Clone the Harness and target repository

Replace `OWNER/REPO` and `/absolute/path/to/repo` with real values:

```bash
git clone https://github.com/Notyet1307/github-agent-harness.git \
  "$HOME/github-agent-harness"

git clone https://github.com/OWNER/REPO.git \
  /absolute/path/to/repo
```

Setup never clones. The target path must already be a Git worktree whose
`origin` fetch and push URLs both identify `OWNER/REPO`. Use the Git root's
absolute path; running `pwd` inside the target repo is the simplest way to get
it.

### 3. Install project dependencies

```bash
cd "$HOME/github-agent-harness"

# Only when pnpm is not already installed at the pinned version.
npm install --global pnpm@10.26.1

pnpm --version  # must print 10.26.1
pnpm install --frozen-lockfile
```

No build step is required for the documented `pnpm harness ...` commands; they
run the TypeScript entrypoint through `tsx`.

### 4. Initialize Pi and Orca once

Start Orca, then initialize the project-local Pi CLI with the provider/model
that this machine will use:

```bash
orca open --json
orca status --json

cd "$HOME/github-agent-harness"
pnpm exec pi
```

Complete Pi's provider/model setup in the TUI, confirm it reaches an idle prompt,
then exit. Credentials remain under the Pi user directory or provider-specific
environment variables; never put them in this repository.

The current Harness also requires three files owned by Orca's Pi integration:
`~/.pi/agent/extensions/orca-prefill.ts`, `orca-agent-status.ts`, and
`orca-titlebar-spinner.ts` (or the equivalent directory selected by
`PI_CODING_AGENT_DIR`). Harness deliberately has no fallback copies or installer
for them. Launch Pi from Orca once so Orca can initialize its integration. If
doctor still reports any of them missing, stop and repair or update Orca; do not
copy extension files from another computer.

### 5. Preview, then apply onboarding

```bash
# Read-only plan. This still queries GitHub and Orca.
pnpm harness setup \
  --repo OWNER/REPO \
  --path /absolute/path/to/repo \
  --dry-run

# Apply local Orca bindings and any required portable config entry.
pnpm harness setup \
  --repo OWNER/REPO \
  --path /absolute/path/to/repo
```

The dry run prints `PLAN` plus `WOULD` actions and does not write config or
mutate Orca. The real command is idempotent: correct registrations and base refs
are reused. If the repository is new to the tracked config, review and commit
the resulting `config/harness.yaml` change intentionally.

Optional overrides are available when GitHub's default branch should not be
used:

```bash
pnpm harness setup \
  --repo OWNER/REPO \
  --path /absolute/path/to/repo \
  --default-branch main \
  --base-ref origin/main
```

`baseRef` must use `origin`. An explicit branch is checked against GitHub before
anything is changed.

### 6. Verify before claiming work

```bash
pnpm harness doctor
pnpm harness pick --dry-run
pnpm harness status
```

Do not start real work until doctor ends with `Result: PASS (no failures)` and
the picker shows the intended issue. `WARN` checks, such as missing optional
validation scripts in a target repo, do not make doctor fail. `pick --dry-run`
does not write the ledger, create a worktree, or mutate labels.

When the preview is correct, the attended entrypoint is:

```bash
pnpm harness work --dry-run --once
pnpm harness work --once
```

Contributors changing the Harness itself should also run `pnpm test`; it is a
repository regression suite, not a prerequisite for every operator cycle.

### Where state lives

| State | Location | Portable? |
|---|---|---|
| GitHub repo slug, default branch, base ref, profiles, policy | `config/harness.yaml` | Yes; tracked |
| Target path and Orca repo id | Orca repo inventory, resolved by GitHub identity | No; recreate with `setup` |
| Jobs and the global single-job slot | `data/harness.sqlite` | No; local and ignored |
| Pi provider/model credentials and Orca-generated extensions | Pi user directory | No; machine-local |
| Harness Pi skills, agents, launchers, and pinned packages | This repository and `node_modules` | Recreated by clone + `pnpm install` |

Never copy `data/harness.sqlite` between computers. Never run controllers on
two computers against the same configured work simultaneously; the ledger and
single-job lock coordinate only one local checkout.

### Routine updates and repairs

Updating the Harness on the same computer normally needs no re-enrollment:

```bash
cd "$HOME/github-agent-harness"
git pull --ff-only
pnpm install --frozen-lockfile
pnpm harness doctor
```

Rerun the top-level `setup --repo ... --path ...` after moving a target checkout,
reinstalling Orca, or losing an Orca binding. Setup fails closed if Orca already
registers the same GitHub identity at a different path. The current public Orca
CLI has no `repo remove` command: the safest immediate option is to reuse the
registered path. To move intentionally, remove the stale repo in the Orca
desktop UI, confirm it no longer appears in `orca repo list --json`, then rerun
setup. Never edit Orca's internal state directly.

`project add` and `project setup` are lower-level enrollment/repair commands.
`project setup --repo ...` or `--all` repairs projects that are already
resolvable from the current Orca inventory; it is not the fresh-machine entry
point when a target path has not been registered. None of these commands create
labels, claim issues, pin a task base SHA, or merge PRs.

### Common onboarding failures

- `project path must be absolute`: pass the Git root's absolute path.
- `origin remote does not match` or `origin push URL does not match`: fix the
  clone's `origin`; setup requires both fetch and push identity to match.
- `Orca already registers ... at ...`: reuse the reported path, or remove the
  stale repo in the Orca desktop UI, verify with `orca repo list --json`, and
  rerun setup; automatic rebinding is intentionally refused.
- Orca CLI/runtime failure: start or update Orca, then rerun setup.
- Missing `orca-prefill.ts`, `orca-agent-status.ts`, or
  `orca-titlebar-spinner.ts`: launch Pi from Orca once. If they remain missing,
  repair or update Orca's Pi integration; Harness cannot install these files.

- `setup refused while job ... is active`: inspect `pnpm harness status` and
  finish the normal flow or reconcile with `recover --dry-run`; never edit or
  delete the ledger by hand.
- `validation-scripts` is `WARN`: this alone is non-fatal; use doctor's final
  `Result` line as the pass/fail decision.

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

### Recommended operator flow

For first use or attended operation, prefer `work --once`. Every invocation
re-inspects the ledger, GitHub, and Orca, then performs only the single automatic
action allowed by current state:

```bash
cd "$HOME/github-agent-harness"

# Inspect current work
pnpm harness status

# Preview the next action
pnpm harness work --dry-run --once

# Execute one action; repeat until a PR exists or explicit recovery is required
pnpm harness work --once

# Confirm the result
pnpm harness status
```

The usual progression is claim and implement → audit/rework → push and create a
PR → wait for a human merge. Harness never merges automatically. After the PR
is merged, run `work --once` again or wait for the next `watch` tick so the
controller records the merge and frees the single-job slot.

Run only one controller at a time. Do not start overlapping `work`/`watch`
processes or run Harness concurrently on two machines.

### Manual one-shot commands

Each command has an explicit stopping point; no one command is the entire
pipeline.

| Command | Description |
|---|---|
| `pnpm harness work --once` | Run one freshly inspected automatic coordinator action; never execute explicit recovery |
| `pnpm harness run-once` | Claim an issue, create or reuse the worktree, and finish implementation; no push or PR |
| `pnpm harness audit-once` | Run the independent Pi audit and controlled rework when needed; no PR |
| `pnpm harness publish-once` | Push and create or reuse the PR after audit passes, then stop at `awaiting_merge` |
| `pnpm harness wait-merge --timeout-minutes 60` | Poll GitHub merge state only; never perform the merge |
| `pnpm harness recover --dry-run` | Show the ensure step that should resume after a crash, without changing state |
| `pnpm harness recover --execute` | Execute the reconciled recovery step |
| `pnpm harness status` | Show the active job, recent jobs, and Orca state |

### Unified work and foreground watch

`work` is the unified coordinator entrypoint. It re-inspects before every cycle,
runs at most one automatic action per cycle, and stops at a stable state,
`awaiting_merge`, a failure, or any action that requires explicit recovery.
Use `--once` to limit it to one cycle.

```bash
pnpm harness work --once
pnpm harness work --repo OWNER/REPO --max-cycles 10 --poll-seconds 30
pnpm harness work --dry-run --once
```

> **Warning: `watch` is an active compatibility controller, not a passive merge
> monitor.** With no active job, it can claim the next eligible labeled issue.
> Later ticks can dispatch agents, run the audit, and push and create a PR.

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

Each `watch` tick:

1. Reconcile the active job from the same evidence used by `recover`.
2. Execute at most one automatic coordinator action: `run-once`, `audit-once`,
   `publish-once`, or one `wait-merge` poll.
3. With no active job, try to claim and implement the next eligible issue; a
   later tick performs the audit after a fresh inspection.
4. Stop rather than execute an explicit recovery action. The operator must use
   `recover --dry-run` and then `recover --execute`.
5. After a human merges the PR, the next poll records `mergedAt` and frees the
   single ledger slot, while retaining the Orca worktree for inspection.
6. A `blocked` job keeps the slot. CI failures or requested changes do not
   automatically trigger rework while waiting for merge.
7. Never auto-merge and never auto-delete completed worktrees.

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

After a controller crash, do not claim a new issue directly. `recover` is the
explicit-recovery compatibility adapter; even `--execute` does not claim when
there is no active job. Run:

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
| Completed malformed audit | Explicit `recover --execute`: discard the malformed artifact and dispatch a fresh auditor for the same round |
| Ended implementation with no commits | Redispatch in the same worktree only through explicit `recover --execute` |
| Other `blocked` | Stop and keep the slot |
| `merged` / no active job | Safe to claim the next issue |

Never edit the ledger by hand or use an ad-hoc script to accept
`.harness/audit-result.json`. Malformed results remain invalid and can only be
recovered by a fresh, fenced audit through `recover --execute`. All audits must
re-enter the strict gate through `audit-once` or `recover --execute`.

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

The Pi CLI and pinned `pi-subagents` live in the project `node_modules` tree and
update through `pnpm install --frozen-lockfile`. Provider credentials and
Orca-managed extensions remain user-scoped and are never stored in the repo.

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
