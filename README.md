# github-agent-harness

[简体中文](README.zh-CN.md)

Run one GitHub issue at a time from implementation to a merged pull request.

~~~text
eligible issue → claim → Orca worktree → implement → independent audit
→ pull request → GitHub or human merge → next eligible issue
~~~

## What it does

github-agent-harness is a local controller for coding agents. It selects an
eligible GitHub issue, creates an isolated Orca worktree, dispatches an
implementer and an independent auditor, then opens a pull request only after
the audit passes.

A SQLite ledger keeps one job in flight. The controller never direct-merges a
pull request or silently skips a failed job. By default it waits for a human
merge. Optional auto mode asks GitHub to merge the audited PR head, while
GitHub remains responsible for CI and review rules.

The controller runs in the foreground. It does not install a background service.
Completed or cancelled worktrees are removed only by the explicit, dry-run-first
`cleanup` command.

## Configure

### 1. Install the local prerequisites

- Node.js 22.19 or newer
- pnpm 10.26.1
- Git and GitHub CLI, authenticated for the target repository
- Orca running locally
- Pi initialized once with the provider and model for this machine

~~~bash
git clone https://github.com/Notyet1307/github-agent-harness.git \
  "$HOME/github-agent-harness"
cd "$HOME/github-agent-harness"
pnpm install --frozen-lockfile

# Start Orca first, then initialize Pi once in its interactive TUI.
pnpm exec pi
~~~

Clone the target repository separately. Harness never clones it for you.

### 2. Register the target repository

Use an absolute Git-root path. Preview first; the real command registers or
reuses Orca bindings and records the portable repository entry in
**config/harness.yaml**.

~~~bash
pnpm harness setup \
  --repo OWNER/REPO \
  --path /absolute/path/to/repo \
  --dry-run

pnpm harness setup \
  --repo OWNER/REPO \
  --path /absolute/path/to/repo

pnpm harness doctor
pnpm harness pick --dry-run
~~~

Do not start work until doctor ends with **Result: PASS (no failures)** and the
picker shows the issue you expect.

### 3. Choose the merge policy

The default is human merge:

~~~yaml
issueLabel: ready-for-agent
pollIntervalSeconds: 120

mergePolicy:
  mode: wait
  autoMerge: false
~~~

To use GitHub auto-merge, first enable **Allow auto-merge** in the target
repository and configure required status checks for its target branch. Harness
expects GitHub's **Require status checks** rule, not only a workflow rule.

Then change both fields together:

~~~yaml
mergePolicy:
  mode: auto
  autoMerge: true
~~~

Before each request, Harness verifies a required-check rule, the PR target
branch, and that the PR head is exactly the audited commit. It waits until
GitHub reports the PR merge state as `CLEAN` before invoking the configured
`gh pr merge --auto --match-head-commit --merge` command.
Missing rules or a changed head block the job instead of merging another
commit.

## Use

### Inspect and advance one step

Use this flow while you are watching the controller:

~~~bash
pnpm harness status
pnpm harness work --dry-run --once
pnpm harness work --once
~~~

Each call rechecks GitHub, Orca, and the ledger. It performs at most one safe
action: claim and implement, audit, publish a PR, or observe a merge.

### Run continuously

Use one foreground watcher when you want the controller to continue after a
merge:

~~~bash
pnpm harness watch --poll-seconds 30
~~~

After GitHub or a human merges the PR, the next watcher tick marks the job
merged, releases the slot, and claims the next eligible issue. Run only one
controller at a time and never run the same configured work from two machines.

In auto mode, Harness requests:

~~~text
gh pr merge --auto --match-head-commit <audited-sha> --merge
~~~

Harness only invokes that command after GitHub reports the required checks as
passing; GitHub CLI may then complete the merge immediately for the matched
head. A failed check, requested changes, a changed PR head, a closed PR, or an
auto-merge error keeps the job visible for explicit recovery; any existing
auto-merge request is disabled when Harness observes an unsafe PR state.
Harness does not auto-rework or jump to another issue.

### Notify an unattended operator

Harness can pass an unresolved worker escalation or decision gate to any local
command on stdin. The hook receives a complete, copyable message: repository
and issue, pipeline stage and role, exact job/task/dispatch/message/HEAD
provenance, worker-supplied options and recommendation when present, a
conservative Harness recommendation, and the explicit recovery command.

For an existing Hermes Telegram pairing, use:

~~~yaml
notifications:
  enabled: true
  command: [hermes, send, --to, telegram, --file, "-", --json]
  timeoutSeconds: 30
  reminderMinutes: [0, 30, 120]
  maxAttemptsPerReminder: 3
~~~

This reuses Hermes credentials; do not copy a Telegram token into Harness.
Before leaving the watcher unattended, verify `hermes gateway status` and
`hermes send --list telegram`. The notification command runs without a shell,
is deduplicated in the ledger, and retries each reminder a bounded number of
times. Delivery failure never unblocks the job. Phase 1 is intentionally
one-way: replying in Telegram does not execute a decision. Review the message,
then run its `harness recover --execute ...` command locally.

### Recover safely

If the process stops or a job is blocked, inspect before doing anything else:

~~~bash
pnpm harness status
pnpm harness recover --dry-run
~~~

Use **recover --execute** only after reviewing the plan. Do not edit
**data/harness.sqlite** by hand.

Worker escalations and decision gates are stored in the ledger with their exact
task, dispatch, message, role, and pipeline-stage provenance. Harness never
answers a decision gate with a generic response. Inspect the request in
`status` or `recover --dry-run`, then resolve it explicitly:

~~~bash
# Accept a completed escalated worker result only after reviewing it.
pnpm harness recover --execute --acknowledge-escalation

# Send the operator's actual decision, then resume the same task.
pnpm harness recover --execute --reply "Stay within the issue scope; do not migrate historical data"
~~~

Acknowledging an escalation still requires the exact recorded task and dispatch,
a completed Orca task, a clean tracked worktree, verified base ancestry, and the
expected commit or audit artifact. A later exact `worker_done` in the same inbox
batch takes precedence over an older escalation.

If the active GitHub issue is closed, Harness blocks instead of silently
discarding the job. Preview and explicitly cancel it with a reason:

~~~bash
pnpm harness cancel --reason "issue closed as not planned" --dry-run
pnpm harness cancel --reason "issue closed as not planned" --execute
~~~

Cancellation is idempotent and releases the single job slot. It preserves the
Orca worktree and Git branch by default. Add `--remove-worktree` only after the
cancel preview confirms that cleanup is safe.

If a post-audit rework worker times out without producing a new commit,
`recover --dry-run` proposes a redispatch only when the old task has failed,
the worktree is still clean at the audited commit, and the audit evidence is
still current. After reviewing that plan, use `recover --execute` to retry the
rework. `watch` does not retry this case automatically.

### Clean terminal worktrees

Preview cleanup of merged and cancelled jobs before applying it:

~~~bash
pnpm harness cleanup --dry-run
pnpm harness cleanup --job JOB_ID --execute
~~~

Cleanup never touches an active job or deletes its branch. It refuses a
worktree with tracked or untracked changes, verifies the recorded Orca
worktree identity plus the checked-out branch and HEAD, removes the worktree
through Orca (which closes its terminals), and then clears stale runtime
handles from the ledger. Omitting `--job` applies the reviewed plan to all
eligible terminal jobs.

## Reference

- Configuration: [config/harness.yaml](config/harness.yaml)
- Design decisions: [docs/decisions.md](docs/decisions.md)
- CLI command list: [src/cli.ts](src/cli.ts)
