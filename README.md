# github-agent-harness

单任务、合并门禁的编码代理控制器。
A single-task coding-agent controller with a merge gate.

```text
Picker → Ledger Claim → Orca Worktree → Pi /skill:implement
  → Pi dual-axis audit → Gate → PR → Human merge → Next
```

## 概览 / Overview

Harness 通过 GitHub issue 选取任务，用 SQLite ledger 保证全局只有一个进行中的
job，通过 Orca 创建隔离 worktree 并派发 Pi implementer 和 Pi auditor。只有独立
audit 通过后，controller 才会 push 分支并创建 PR。Harness 永不执行 merge；
合并由外部人工动作触发，并且必须满足适用的 branch protection 规则。

The harness selects work from GitHub issues, uses a SQLite ledger to allow only
one in-flight job globally, and asks Orca to create an isolated worktree and
dispatch the Pi implementer and Pi auditor. The controller pushes a branch and
opens a PR only after an independent audit passes. The harness never merges;
an external human action performs the merge after all applicable branch
protection requirements are satisfied.

| 阶段 / Milestone | 命令 / Command | 状态 / Status |
|---|---|---|
| M0 | `pnpm harness doctor` | 已实现：检查配置与运行环境 / Implemented: configuration and runtime checks |
| M1 | `pnpm harness pick --dry-run` | 已实现：只读选取预览 / Implemented: read-only picker preview |
| M2 | `pnpm harness run-once` | 已实现：停在实现提交完成 / Implemented: stops after implementation commits |
| M3 | `pnpm harness audit-once` | 已实现：Pi 双轴 audit 与 rework gate，不创建 PR / Implemented: Pi two-axis audit and rework gate, no PR |
| M4 | `pnpm harness publish-once` / `wait-merge` | 已实现：创建 PR 并等待人工合并 / Implemented: create PR and wait for human merge |
| M5 | `pnpm harness recover` | 已实现：对账并恢复一个 ensure step / Implemented: reconcile and resume one ensure step |
| M6 | `pnpm harness watch` | 已实现：前台轮询控制器，不自动合并 / Implemented: foreground polling controller, never auto-merges |
| 部署 / Deployment | macOS `launchd` | 延后：本仓库没有 plist 或服务命令 / Deferred: this repository has no plist or service commands |

## 快速开始 / Quick start

需要 Node.js 20+、pnpm、已认证的 `gh`、可用的 Orca runtime，以及配置中所需
的 Pi 资源。
Requires Node.js 20+, pnpm, an authenticated `gh`, a ready Orca runtime, and
the Pi resources required by the configuration.

```bash
cd ~/github-agent-harness
pnpm install
pnpm harness doctor
pnpm harness pick --dry-run
pnpm test
```

主配置位于 [`config/harness.yaml`](config/harness.yaml)。开始真实任务前，应确保
`doctor` 为 PASS，并先用 dry-run 核对将被领取的 issue。
The main configuration is
[`config/harness.yaml`](config/harness.yaml). Before real work, require a
passing `doctor` result and use the dry-run picker to verify the issue that
would be claimed.

## 运行方式 / Operating modes

### 分阶段命令 / Manual one-shot commands

这些命令各自有明确停止点，不是单个端到端命令。
Each command has an explicit stopping point; no one command is the entire
pipeline.

| 命令 / Command | 中文说明 | English |
|---|---|---|
| `pnpm harness run-once` | 领取 issue、创建或复用 worktree、完成实现；不 push、不建 PR | Claim an issue, create or reuse the worktree, and finish implementation; no push or PR |
| `pnpm harness audit-once` | 运行独立 Pi audit，必要时执行受控 rework；不建 PR | Run the independent Pi audit and controlled rework when needed; no PR |
| `pnpm harness publish-once` | audit 通过后 push 并创建或复用 PR，停在 `awaiting_merge` | Push and create or reuse the PR after audit passes, then stop at `awaiting_merge` |
| `pnpm harness wait-merge --timeout-minutes 60` | 只监控 GitHub 合并状态，绝不执行 merge | Poll GitHub merge state only; never perform the merge |
| `pnpm harness recover --dry-run` | 只读显示崩溃后应恢复的 ensure step | Show the ensure step that should resume after a crash, without changing state |
| `pnpm harness recover --execute` | 执行已核对的恢复步骤 | Execute the reconciled recovery step |
| `pnpm harness status` | 显示 active job、最近 job 与 Orca 状态 | Show the active job, recent jobs, and Orca state |

### 前台 Watch / Foreground watch

> **注意：`watch` 是主动控制器，不是被动 merge monitor。** 没有 active job
> 时，它会领取下一个带配置标签且未阻塞的 issue，派发 agent、运行 audit，并在
> 后续周期 push 和创建 PR。
>
> **Warning: `watch` is an active controller, not a passive merge monitor.**
> With no active job, it claims the next eligible labeled issue, dispatches
> agents, runs the audit, and pushes and creates a PR in later cycles.

```bash
pnpm harness watch
pnpm harness watch --once
pnpm harness watch --dry-run --once
pnpm harness watch --max-cycles 10 --poll-seconds 30
```

当前 `watch` 只以前台进程运行；关闭终端或进程退出后就不再监控。默认轮询间隔
来自 `pollIntervalSeconds`（当前默认 120 秒）。`SIGINT` 和 `SIGTERM` 会让它在
当前周期结束后退出。
Today `watch` runs only as a foreground process; monitoring stops when its
terminal or process exits. The default interval comes from
`pollIntervalSeconds` (currently 120 seconds). `SIGINT` and `SIGTERM` stop it
after the current cycle.

每个周期 / Each cycle:

1. 对账 active job，与 `recover` 使用相同事实源。
   Reconcile the active job from the same evidence used by `recover`.
2. 有 active job 时，只恢复一个 ensure step：`run-once`、`audit-once`、
   `publish-once` 或一次 `wait-merge` poll。
   With an active job, resume one ensure step: `run-once`, `audit-once`,
   `publish-once`, or one `wait-merge` poll.
3. 没有 active job 时，尝试领取并实现下一个 eligible issue；若实现同周期完成，
   会立即串联一次 audit。
   With no active job, try to claim and implement the next eligible issue; if
   implementation finishes in that cycle, chain one audit immediately.
4. PR 被人工合并后，下一次 poll 记录 `mergedAt` 并释放 ledger 单槽，但保留 Orca
   worktree 供检查。
   After a human merges the PR, the next poll records `mergedAt` and frees the
   single ledger slot, while retaining the Orca worktree for inspection.
5. `blocked` job 继续占槽；CI 失败或 requested changes 不会在等待合并阶段自动
   触发 rework。
   A `blocked` job keeps the slot. CI failures or requested changes do not
   automatically trigger rework while waiting for merge.
6. 永不自动 merge，也不自动删除已完成 worktree。
   Never auto-merge and never auto-delete completed worktrees.

### launchd 常驻服务（延后）/ launchd service (deferred)

本仓库当前**没有** launchd plist，也没有 install/start/status/uninstall 服务命令，
不会安装或启动常驻 watcher。正式部署仓库启用前，请继续使用前台
`pnpm harness watch`。
This repository currently has **no** launchd plist and no
install/start/status/uninstall service commands, and it does not install or
start a persistent watcher. Use foreground `pnpm harness watch` until the
production repository enables the service.

未来启用 launchd 时，至少必须满足以下条件：
Before launchd is enabled, the production repository must at minimum:

- 固定 Node 可执行文件、仓库工作目录和构建后的 CLI 路径。
  Pin the Node executable, repository working directory, and built CLI path.
- 显式提供 `HOME` 与稳定的 `PATH`，确保 `gh`、`git`、`orca` 和 `pi` 可用。
  Provide `HOME` and a stable `PATH` so `gh`, `git`, `orca`, and `pi` resolve.
- 在加载服务前运行 `doctor`，提供 stdout/stderr 日志，并验证单实例与卸载流程。
  Run `doctor` before loading, configure stdout/stderr logs, and verify
  single-instance and uninstall behavior.
- 在启用登录启动和崩溃重启前，验证 `bootout` 能在同步 poll sleep 期间及时退出；
  当前信号处理可能延迟到最长一个 poll interval。
  Before enabling login startup and crash restart, verify that `bootout`
  exits promptly during the synchronous poll sleep; current signal handling
  may be delayed by up to one poll interval.
- 禁止与手工启动的 foreground watcher 并跑，不在 plist 中保存 token，并为日志
  设置轮转策略。
  Never run alongside a manually started foreground watcher, never store
  tokens in the plist, and define log rotation.
- 明确继承上面的完整 `watch` 行为：会自动领取新 issue，但不会自动 merge 或删除
  worktree。
  Explicitly inherit the full `watch` behavior above: it will auto-claim new
  issues, but will not auto-merge or delete worktrees.

## 恢复与可靠性 / Recovery and reliability

Controller 崩溃后不要直接领取新 issue，先执行：
After a controller crash, do not claim a new issue directly. Run:

```bash
pnpm harness recover --dry-run
pnpm harness recover --execute
```

| Ledger 状态 / State | 恢复动作 / Resume action |
|---|---|
| `claimed` / `worktree_ready` / `implementing` | `run-once`：复用 worktree；已有提交时核验后完成，不重复等待 / Reuse the worktree; verify and finalize existing commits without re-waiting |
| `awaiting_audit` / `auditing` / `reworking` | `audit-once`：只复用同轮、同 SHA、来源完整的结果 / Reuse only same-round, exact-SHA results with complete provenance |
| `audit_passed` / `publishing` | `publish-once`：按 head 查找并复用 PR / Find and reuse the PR by head |
| `awaiting_merge` | `wait-merge`：只轮询并记录结果 / Poll and record the result only |
| 可恢复的 blocked audit / Recoverable blocked audit | `audit-once`：重新经过正常 gate / Re-enter the normal gate |
| 无提交的 ended implementation / Ended implementation with no commits | 仅显式 `recover --execute` 才在原 worktree 重派 / Redispatch in the same worktree only through explicit `recover --execute` |
| 其他 `blocked` / Other `blocked` | 不继续，持续占槽 / Stop and keep the slot |
| `merged` / 无 active job / No active job | 可安全领取下一项 / Safe to claim the next issue |

不得手工编辑 ledger，也不得用临时脚本直接接受
`.harness/audit-result.json`。Audit 只能通过 `audit-once` 或
`recover --execute` 回到严格 gate。
Never edit the ledger by hand or use an ad-hoc script to accept
`.harness/audit-result.json`. Audits must re-enter the strict gate through
`audit-once` or `recover --execute`.

在领取前，`run-once` 刷新配置的 remote-tracking `baseRef`，固定完整 SHA，并要求
Orca worktree HEAD 精确匹配。Dispatch 前要求 TUI idle，dispatch 后探测 task id
或新的 Working 信号；`worker_done` 必须匹配当前 task 和已记录的 dispatch id。
Before claiming, `run-once` refreshes the configured remote-tracking `baseRef`,
pins its full SHA, and requires the Orca worktree HEAD to match exactly. It
requires an idle TUI before dispatch and probes for the task id or fresh Working
signals afterward. A `worker_done` message must match the current task and the
recorded dispatch id.

## 当前 Pi 角色 / Active Pi roles

```yaml
activeProfiles:
  implementer: pi-implementer
  auditor: pi-reviewer
```

| 角色 / Role | Profile | 权限与职责 / Permissions and responsibility |
|---|---|---|
| Implementer | `pi-implementer` | 使用 `read,edit,write,bash,subagent` 实现、测试、提交和 rework，并运行隔离的内部双轴 review / Uses `read,edit,write,bash,subagent` for implementation, tests, commits, rework, and isolated internal two-axis review |
| Auditor parent | `pi-reviewer` | 不得修改 tracked files 或 HEAD；可写唯一 gate 证据 `.harness/audit-result.json` / Must not modify tracked files or HEAD; may write the sole gate artifact `.harness/audit-result.json` |
| Internal reviewer | `harness-reviewer` | fresh user scope、无 artifacts，只向 parent 返回 Standards 或 Spec 报告 / Fresh user scope, no artifacts, returns only a Standards or Spec report to its parent |

Implementer 显式加载 controller-owned Matt `implement` 与 `tdd`（固定到
[`ed37663`](https://github.com/mattpocock/skills/tree/ed37663cc5fbef691ddfecd080dff42f7e7e350d)）
以及 Pi-adapted `code-review`。它只加载 Orca prefill/status 和已批准版本的
`pi-subagents`；不加载 ReadSeek。自动 skill、extension、prompt-template 与
project Pi resource discovery 均关闭，但仍读取仓库 `AGENTS.md` /
`CLAUDE.md`。
The implementer explicitly loads controller-owned Matt `implement` and `tdd`
pinned to
[`ed37663`](https://github.com/mattpocock/skills/tree/ed37663cc5fbef691ddfecd080dff42f7e7e350d),
plus the Pi-adapted `code-review`. It loads only Orca prefill/status and the
approved `pi-subagents` version; ReadSeek is not loaded. Automatic skill,
extension, prompt-template, and project Pi resource discovery are disabled,
while repository `AGENTS.md` / `CLAUDE.md` context remains enabled.

Implementer 和 auditor 当前仍共享父 Pi provider/model 与
`PI_CODING_AGENT_DIR`；角色级 provider/config 隔离尚未实现。Internal reviewer
通过 wrapper 移除 parent 的 Orca lifecycle handles。
The implementer and auditor still share the parent Pi provider/model and
`PI_CODING_AGENT_DIR`; role-level provider/config isolation remains deferred.
Internal reviewers use a wrapper that removes the parent's Orca lifecycle
handles.

> Pi 的 tool allowlist **不是 OS sandbox**。特别是 `bash` 与 TypeScript
> extensions 仍拥有 Pi 进程的文件系统、凭证和网络权限，真正隔离必须在 Pi
> 外部完成。
>
> Pi's tool allowlist is **not an OS sandbox**. In particular, `bash` and
> TypeScript extensions retain the Pi process's filesystem, credential, and
> network access. Real isolation must be enforced outside Pi.

## 硬约束 / Hard rules

1. Agent 不得创建、添加或移除 GitHub labels。
   Agents never create, add, or remove GitHub labels.
2. 全局最多一个 in-flight issue；只有 merge 或显式取消后才释放。
   At most one issue may be in flight globally; only merge or explicit
   cancellation frees the slot.
3. 只有 implementer 可修改 tracked product files；auditor 仅可写 gate artifact。
   Only the implementer may modify tracked product files; the auditor may write
   only the gate artifact.
4. 独立 Pi audit 通过前不得创建 PR。
   No PR may be created before the independent Pi audit passes.
5. PR merge 前不得领取下一项。
   Do not claim the next issue before the PR is merged.
6. Closed-unmerged、audit exhausted 或 issue revoked 必须进入 blocked，不能跳过。
   Closed-unmerged, audit-exhausted, or revoked issues must block; never skip
   ahead.
7. 永不自动 merge，永不自动删除完成的 worktree。
   Never auto-merge and never auto-delete completed worktrees.

## 配置、状态与决策 / Configuration, state, and decisions

- 配置 / Configuration: [`config/harness.yaml`](config/harness.yaml)
- 业务状态 / Business state: `data/harness.sqlite`
- 运行日志 / Runtime logs: controller 前台输出与 Orca terminals / controller
  foreground output and Orca terminals
- 架构决策 / Architecture decisions: [`docs/decisions.md`](docs/decisions.md)

Orca 是唯一执行层，负责 worktree、terminal、dispatch、task 与
`worker_done`；业务状态以 SQLite ledger 为准。
Orca is the sole execution layer for worktrees, terminals, dispatches, tasks,
and `worker_done`; the SQLite ledger is authoritative for business state.
