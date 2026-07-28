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

The controller runs in the foreground. It does not install a background service
or delete completed worktrees.

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

### Recover safely

If the process stops or a job is blocked, inspect before doing anything else:

~~~bash
pnpm harness status
pnpm harness recover --dry-run
~~~

Use **recover --execute** only after reviewing the plan. Do not edit
**data/harness.sqlite** by hand.

## Reference

- Configuration: [config/harness.yaml](config/harness.yaml)
- Design decisions: [docs/decisions.md](docs/decisions.md)
- CLI command list: [src/cli.ts](src/cli.ts)
