# github-agent-harness

[English](README.md)

把一个 GitHub issue 按顺序推进到已合并 PR，并且同一时间只处理一个任务。

~~~text
合格 issue → 领取 → Orca worktree → 实现 → 独立审计
→ 创建 PR → GitHub 或人工合并 → 下一个合格 issue
~~~

## 它做什么

github-agent-harness 是本地运行的 coding-agent controller。它从 GitHub 选择合格
issue，创建隔离的 Orca worktree，派发 implementer 与独立 auditor；只有 audit
通过后才会 push 并创建 PR。

SQLite ledger 保证全局只有一个 in-flight job。Controller 不会直接 merge PR，也不会
静默跳过失败任务。默认等待人工合并；可选 auto 模式只请求 GitHub 合并已审计的 PR
HEAD，CI 与 review 仍由 GitHub 规则决定。

它目前只作为前台进程运行，不会安装后台服务。已合并或已取消的 worktree 只会由显式、
默认先 dry-run 的 `cleanup` 命令删除。

## 配置

### 1. 准备本机环境

- Node.js 22.19 或更新版本
- pnpm 10.26.1
- Git 与已登录、可访问目标仓库的 GitHub CLI
- 本机已启动的 Orca
- 在本机完成过一次 provider/model 初始化的 Pi

~~~bash
git clone https://github.com/Notyet1307/github-agent-harness.git \
  "$HOME/github-agent-harness"
cd "$HOME/github-agent-harness"
pnpm install --frozen-lockfile

# 先启动 Orca，再在交互式 TUI 中完成一次 Pi 初始化。
pnpm exec pi
~~~

目标仓库需要单独 clone；Harness 不会替你 clone。

### 2. 接入目标仓库

传入目标 Git 根目录的绝对路径。先预览；真实命令会注册或复用 Orca binding，并把可移植
的仓库条目写入 **config/harness.yaml**。

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

只有 doctor 最后一行是 **Result: PASS (no failures)**，且 picker 显示预期 issue 时，
才开始真实任务。

### 3. 选择合并策略

默认等待人工合并：

~~~yaml
issueLabel: ready-for-agent
pollIntervalSeconds: 120

mergePolicy:
  mode: wait
  autoMerge: false
~~~

要使用 GitHub 自动合并，先在目标仓库打开 **Allow auto-merge**，并在目标分支上配置
required status checks。Harness 当前要求 GitHub 的 **Require status checks** 规则，
不能只配置 workflow rule。

然后同时改动两个字段：

~~~yaml
mergePolicy:
  mode: auto
  autoMerge: true
~~~

每次请求前，Harness 都会核验 required-check rule、PR 的目标分支，以及 PR HEAD 是否
精确等于已审计 commit。缺少规则或 HEAD 已变化都会 block job，而不是合并另一个提交。

## 使用

### 人工查看并推进一步

人工值守时使用：

~~~bash
pnpm harness status
pnpm harness work --dry-run --once
pnpm harness work --once
~~~

每次调用都会重新检查 GitHub、Orca 与 ledger，且最多执行一个安全动作：领取并实现、
审计、创建 PR，或观察合并结果。

### 持续运行

需要 PR 合并后继续领取下一项时，只启动一个前台 watcher：

~~~bash
pnpm harness watch --poll-seconds 30
~~~

GitHub 或人工合并 PR 后，下一次 watcher tick 会记录 merged、释放单槽，并领取下一个
合格 issue。不要同时启动多个 controller，也不要让两台电脑并行处理同一组任务。

auto 模式实际请求的是：

~~~text
gh pr merge --auto --match-head-commit <audited-sha>
~~~

GitHub 负责等待 required checks。CI 失败、requested changes、PR 被关闭或 auto-merge
请求失败时，job 会保留供显式处理；Harness 不会自动 rework，也不会跳到下一个 issue。

### 通知不值守操作者

Harness 可以把未解决的 worker escalation 或 decision gate 通过 stdin 交给任意本地
command hook。消息包含仓库与 Issue、流水线阶段与角色、精确的
job/task/dispatch/message/HEAD、Worker 提供的选项与建议（如果有）、Harness 的保守建议，
以及可复制的显式恢复命令。

已有 Hermes Telegram pairing 时可配置：

~~~yaml
notifications:
  enabled: true
  command: [hermes, send, --to, telegram, --file, "-", --json]
  timeoutSeconds: 30
  reminderMinutes: [0, 30, 120]
  maxAttemptsPerReminder: 3
~~~

该方式复用 Hermes 凭据，不要把 Telegram token 复制进 Harness。不值守运行 watcher 前，
先检查 `hermes gateway status` 和 `hermes send --list telegram`。通知命令不会经过 shell；
投递状态在 ledger 中去重，每个提醒时点只进行有限次数重试。通知失败绝不会解除 job 的
blocked。第 1 阶段刻意保持单向：在 Telegram 中回复不会执行决定；请先审阅消息，再到
本机运行消息中的 `harness recover --execute ...` 命令。

### 安全恢复

进程中断或 job 被 block 时，先检查：

~~~bash
pnpm harness status
pnpm harness recover --dry-run
~~~

只有审查过计划后才执行 **recover --execute**。不要手工编辑
**data/harness.sqlite**。

Worker 的 escalation 与 decision gate 会连同精确的 task、dispatch、message、角色和
流水线阶段写入 ledger。Harness 不会再用通用文本自动回答 decision gate。先通过
`status` 或 `recover --dry-run` 审阅请求，再显式处理：

~~~bash
# 审阅后，接受已经完成的 escalated worker 结果。
pnpm harness recover --execute --acknowledge-escalation

# 发送操作者的真实决定，再恢复原任务。
pnpm harness recover --execute --reply "保持 Issue 范围，不迁移历史数据"
~~~

确认 escalation 时仍会校验：精确匹配已记录的 task 与 dispatch、Orca task 已完成、
tracked worktree 干净、base 祖先关系成立，并且存在预期 commit 或 audit artifact。
如果同一批 inbox 消息中较旧 escalation 后已有精确匹配的 `worker_done`，以后者为准。

如果活动 GitHub Issue 已关闭，Harness 会 block，而不会静默丢弃 job。先预览，再带原因
显式取消：

~~~bash
pnpm harness cancel --reason "issue closed as not planned" --dry-run
pnpm harness cancel --reason "issue closed as not planned" --execute
~~~

取消操作幂等，并会释放单任务槽位；默认保留 Orca worktree 与 Git 分支。只有 cancel
预览确认安全后，才附加 `--remove-worktree`。

如果审计后的返工 worker 超时且没有产生新提交，只有在旧任务已经失败、
worktree 仍干净地停留在已审计提交、审计证据仍然有效时，
`recover --dry-run` 才会提出重新派发计划。审查计划后，使用
`recover --execute` 重试返工；`watch` 不会自动重试这种情况。

### 清理终态 worktree

先预览已合并和已取消 job 的清理计划，再执行：

~~~bash
pnpm harness cleanup --dry-run
pnpm harness cleanup --job JOB_ID --execute
~~~

Cleanup 不会处理活动 job，也不会删除分支。它会拒绝包含 tracked 或 untracked 改动的
worktree，核验 ledger 中记录的完整 Orca worktree identity、当前分支和 HEAD，通过
Orca 删除 worktree（同时关闭其中 terminals），最后清除 ledger 中失效的运行时句柄。
省略 `--job` 时，会把已审阅的计划应用到全部符合条件的终态 job。

## 参考

- 配置：[config/harness.yaml](config/harness.yaml)
- 设计决策：[docs/decisions.md](docs/decisions.md)
- CLI 命令入口：[src/cli.ts](src/cli.ts)
