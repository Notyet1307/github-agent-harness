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

它目前只作为前台进程运行，不会安装后台服务，也不会删除已完成的 worktree。

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

### 安全恢复

进程中断或 job 被 block 时，先检查：

~~~bash
pnpm harness status
pnpm harness recover --dry-run
~~~

只有审查过计划后才执行 **recover --execute**。不要手工编辑
**data/harness.sqlite**。

## 参考

- 配置：[config/harness.yaml](config/harness.yaml)
- 设计决策：[docs/decisions.md](docs/decisions.md)
- CLI 命令入口：[src/cli.ts](src/cli.ts)
