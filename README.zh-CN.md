# github-agent-harness

[English](README.md)

单任务、合并门禁的编码代理控制器。

```text
Picker → Ledger Claim → Orca Worktree → Pi /skill:implement
  → Pi dual-axis audit → Gate → PR → GitHub 或人工 merge → Next
```

## 概览

Harness 通过 GitHub issue 选取任务，用 SQLite ledger 保证全局只有一个进行中的
job，通过 Orca 创建隔离 worktree 并派发 Pi implementer 和 Pi auditor。只有独立
audit 通过后，controller 才会 push 分支并创建 PR。默认由人工在满足适用的 branch
protection 后合并；可选 auto 模式只向 GitHub 请求合并已审计的 PR HEAD，CI/review
门槛仍以 GitHub branch rule 为准。

| 阶段 | 命令 | 状态 |
|---|---|---|
| M0 | `pnpm harness doctor` | 已实现：检查配置与运行环境 |
| 新电脑接入 | `pnpm harness setup` | 已实现：幂等完成 Git、GitHub、配置与 Orca 接入 |
| M1 | `pnpm harness pick --dry-run` | 已实现：只读选取预览 |
| M2 | `pnpm harness run-once` | 已实现：停在实现提交完成 |
| M3 | `pnpm harness audit-once` | 已实现：Pi 双轴 audit 与 rework gate，不创建 PR |
| M4 | `pnpm harness publish-once` / `wait-merge` | 已实现：创建 PR 并等待，或请求 GitHub 自动合并 |
| M5 | `pnpm harness recover` | 已实现：对账并恢复一个 ensure step |
| M6 | `pnpm harness watch` | 已实现：前台轮询控制器 |
| 部署 | macOS `launchd` | 延后：本仓库没有 plist 或服务命令 |

## 新电脑接入

当前接入边界是刻意设计的：GitHub identity 与策略进入版本控制；本机路径、Orca id、
SQLite ledger、extensions 和凭证都留在本机。换电脑时应重建这些本地绑定，不应复制
旧电脑的 ledger，也不应把绝对路径写进 YAML。

### `setup` 会自动完成什么

`pnpm harness setup --repo OWNER/REPO --path /absolute/path/to/repo` 是新电脑接入的
主命令。它会：

1. 验证路径是绝对路径、可读取，且属于 Git worktree。
2. 验证 `origin` 的所有 fetch/push URL 都指向 `OWNER/REPO`。
3. 从 GitHub 发现或校验默认分支，并校验 `origin/...` 形式的 base ref。
4. 在 Orca 中注册或复用 Harness 仓库和目标仓库。
5. 设置目标 Orca repo 的 worktree base ref。
6. 仅在需要时把可移植的 repository 配置写入 `config/harness.yaml`，同时保留无关
   YAML 内容与文件权限。
7. 真实 setup 成功后自动运行 doctor。

Setup **不会** clone 仓库、安装或登录外部工具、创建 GitHub label、复制 provider
凭证、安装 Orca 管理的 Pi extensions、领取 issue、创建任务 worktree 或合并 PR。
本地 ledger 存在 active job 时，真实 setup 会拒绝执行。

### 1. 准备本机依赖

| 依赖 | 要求 | 检查命令 |
|---|---|---|
| Node.js | 22.19 或更高 | `node --version` |
| pnpm | 必须是 `packageManager` 声明的 10.26.1 | `pnpm --version` |
| Git | 能 clone、fetch 和 push 目标仓库 | `git --version` |
| GitHub CLI | 已登录且拥有目标仓库的 issue、branch、PR 权限 | `gh auth status` |
| Orca | App 已启动，CLI runtime ready | `orca status` |
| Pi 用户目录 | 已配置 provider/model，且 Orca Pi extensions 已生成 | 安装依赖后初始化，再用 `doctor` 验证 |

`pnpm install` 会提供固定版本的 Pi CLI 与 `pi-subagents`，不需要全局安装 Pi。
Harness 自有的 skills、prompts、launchers 和 auditor 定义都在本仓库中。Provider
凭证与 Orca 生成的 Pi extensions 留在用户 Pi 目录，不进入 Git。

### 2. Clone Harness 与目标仓库

将 `OWNER/REPO` 与 `/absolute/path/to/repo` 替换为实际值：

```bash
git clone https://github.com/Notyet1307/github-agent-harness.git \
  "$HOME/github-agent-harness"

git clone https://github.com/OWNER/REPO.git \
  /absolute/path/to/repo
```

Setup 不负责 clone。目标路径必须已经是 Git worktree，并且 `origin` 的 fetch 与 push
URL 都指向 `OWNER/REPO`。请传 Git 根目录的绝对路径；最简单的方式是在目标仓库中
运行 `pwd`。

### 3. 安装项目依赖

```bash
cd "$HOME/github-agent-harness"

# 仅在尚未安装固定版本 pnpm 时执行。
npm install --global pnpm@10.26.1

pnpm --version  # 必须输出 10.26.1
pnpm install --frozen-lockfile
```

文档中的 `pnpm harness ...` 命令通过 `tsx` 直接运行 TypeScript 入口，不需要先执行
build。

### 4. 首次初始化 Pi 与 Orca

启动 Orca，再用本机计划使用的 provider/model 初始化项目内 Pi CLI：

```bash
orca open --json
orca status --json

cd "$HOME/github-agent-harness"
pnpm exec pi
```

在 Pi TUI 中完成 provider/model 配置，确认进入空闲输入状态后退出。凭证必须留在 Pi
用户目录或 provider 对应的环境变量中，不能写入本仓库。

当前 Harness 还依赖 Orca Pi integration 管理的三个文件：
`~/.pi/agent/extensions/orca-prefill.ts`、`orca-agent-status.ts` 与
`orca-titlebar-spinner.ts`；如果设置了 `PI_CODING_AGENT_DIR`，则使用该目录下的对应
文件。Harness 有意不保存 fallback 副本，也没有安装器。请先从 Orca 启动一次 Pi，
让 Orca 初始化 integration。如果 doctor 仍报告文件缺失，停止接入并修复或更新
Orca；不要从另一台电脑复制 extension 文件。

### 5. 预览并执行接入

```bash
# 只读计划；仍会查询 GitHub 与 Orca。
pnpm harness setup \
  --repo OWNER/REPO \
  --path /absolute/path/to/repo \
  --dry-run

# 写入本机 Orca 绑定，以及必要的可移植配置项。
pnpm harness setup \
  --repo OWNER/REPO \
  --path /absolute/path/to/repo
```

Dry run 会输出 `PLAN` 与 `WOULD` actions，不写配置，也不修改 Orca。真实命令是幂等
的：正确的 registration 与 base ref 会直接复用。如果该仓库原先不在跟踪配置中，
请审查并有意识地提交 `config/harness.yaml` 变更。

如果不能使用 GitHub 默认分支，可显式覆盖：

```bash
pnpm harness setup \
  --repo OWNER/REPO \
  --path /absolute/path/to/repo \
  --default-branch main \
  --base-ref origin/main
```

`baseRef` 必须使用 `origin`。任何显式分支都会先在 GitHub 上校验，再执行变更。

### 6. 领取任务前验证

```bash
pnpm harness doctor
pnpm harness pick --dry-run
pnpm harness status
```

Doctor 最后一行必须是 `Result: PASS (no failures)`，并且 Picker 必须显示预期 issue，
之后才能开始真实任务。目标仓库缺少可选 validation scripts 等 `WARN` 不会令 doctor
失败。`pick --dry-run` 不写 ledger、不创建 worktree，也不修改 label。

预览正确后，人工值守入口是：

```bash
pnpm harness work --dry-run --once
pnpm harness work --once
```

修改 Harness 本身的贡献者还应运行 `pnpm test`；这是仓库回归测试，不是每个 operator
cycle 的前置条件。

### 状态分别存在哪里

| 状态 | 位置 | 是否可移植 |
|---|---|---|
| GitHub repo slug、默认分支、base ref、profiles、策略 | `config/harness.yaml` | 是；进入 Git |
| 目标路径与 Orca repo id | Orca repo inventory，按 GitHub identity 动态解析 | 否；用 `setup` 重建 |
| Jobs 与全局单任务槽 | `data/harness.sqlite` | 否；本地文件且被忽略 |
| Pi provider/model 凭证与 Orca 生成的 extensions | Pi 用户目录 | 否；本机状态 |
| Harness Pi skills、agents、launchers 与固定依赖 | 本仓库及 `node_modules` | 通过 clone + `pnpm install` 重建 |

不要在电脑之间复制 `data/harness.sqlite`。不要让两台电脑同时对同一组已配置任务运行
controller；ledger 与单任务锁只能协调当前本地 checkout。

### 日常更新与修复

同一台电脑更新 Harness 通常不需要重新接入：

```bash
cd "$HOME/github-agent-harness"
git pull --ff-only
pnpm install --frozen-lockfile
pnpm harness doctor
```

移动目标 checkout、重装 Orca 或丢失 Orca binding 后，重新运行顶层
`setup --repo ... --path ...`。如果 Orca 已把同一 GitHub identity 注册在其他路径，
setup 会 fail closed。当前公开 Orca CLI 没有 `repo remove` 命令；最安全的即时方案是
继续使用已注册路径。如果必须移动，请在 Orca 桌面 UI 删除旧 repo，运行
`orca repo list --json` 确认它已消失，再重新 setup。不要直接编辑 Orca 内部状态。

`project add` 与 `project setup` 是底层接入/修复命令。`project setup --repo ...` 或
`--all` 只修复当前 Orca inventory 已能解析的项目；目标路径尚未注册时，它不能替代
新电脑上的顶层 setup。以上命令都不会创建 label、领取 issue、固定任务 base SHA 或
执行 merge。

### 常见接入失败

- `project path must be absolute`：传入 Git 根目录的绝对路径。
- `origin remote does not match` 或 `origin push URL does not match`：修复 clone 的
  `origin`；fetch 与 push identity 都必须匹配。
- `Orca already registers ... at ...`：使用提示中的已注册路径；或者在 Orca 桌面 UI
  删除旧 repo，以 `orca repo list --json` 确认后重新 setup。系统有意拒绝自动改绑。
- Orca CLI/runtime 失败：启动或更新 Orca，再重新运行 setup。
- 缺少 `orca-prefill.ts`、`orca-agent-status.ts` 或 `orca-titlebar-spinner.ts`：先从
  Orca 启动一次 Pi；如果仍然缺失，修复或更新 Orca Pi integration。Harness 不能
  安装这些文件。
- `setup refused while job ... is active`：运行 `pnpm harness status`，完成正常流程或用
  `recover --dry-run` 对账；不要手工编辑或删除 ledger。
- `validation-scripts` 为 `WARN`：它本身不阻断运行，以 doctor 最后一行的 `Result`
  为最终判断。

## Wayfinder Map 选择

带 ready 标签且拥有 GitHub sub-issues 的 issue 是 Wayfinder Map 容器，不是可执行
任务。Picker 仍按父级 issue 编号排列顶层候选，但每张 Map 最多只贡献一个 frontier
child；child 严格按 GitHub 原生 sub-issue 顺序选择，且必须处于 OPEN、带
`issueLabel`、没有开放 blocker、没有 assignee，并且尚未进入 ledger。有 parent 的
child 只能经所属 Map 参与选择，不能依靠自身编号绕过 Map 顺序。

Map 和可执行 child 都必须出现在 ready 标签快照中。在 winner 之前遇到的 OPEN child
若没有 ready 标签，该 Map 在本轮没有 frontier；关系不完整、冲突或出现嵌套 Map
时同样 fail closed。没有 frontier 的 Map 不会阻止无关 standalone issue 或后续 Map。

该能力只负责选择：controller 不添加 assignee、不修改标签、不 resolve child，也不
自动关闭已完成的 Map。`run-once --issue N` 只是断言 N 是当前 Picker winner，不能
覆盖 Map 顺序或 gate。当前只支持一层 GitHub 原生 sub-issues，不支持正文 task-list
fallback 或嵌套 Map。

## 运行方式

### 推荐：逐步推进

首次运行或人工值守时，优先使用 `work --once`。每次调用都会重新检查 ledger、GitHub
与 Orca，只执行当前状态允许的一个自动动作：

```bash
cd "$HOME/github-agent-harness"

# 查看当前任务与状态
pnpm harness status

# 只读预览下一步
pnpm harness work --dry-run --once

# 执行下一步；按状态重复运行，直到创建 PR 或需要显式恢复
pnpm harness work --once

# 再次确认结果
pnpm harness status
```

典型状态推进为：领取并实现 → audit/rework → push 并创建 PR → 等待人工或 GitHub
自动 merge。PR 合并后，再运行一次 `work --once` 或等待下一个 `watch` tick，
controller 会记录合并并释放单任务槽。

### 合并策略

默认是 `wait`。`auto` 必须显式启用，且不执行直接 merge：

```yaml
mergePolicy:
  mode: auto
  autoMerge: true
```

启用前，先在 GitHub 打开 **Allow auto-merge**，并为目标分支配置至少一个 required
status check。每次请求前 Harness 都会核验该规则和 PR HEAD 是否精确等于已审计 HEAD。
缺少 CI 规则或 HEAD 不一致会阻塞 job；CI 失败、requested changes 或 GitHub 自动合并
请求失败都会继续占用 slot。

同一时间只能运行一个 controller。不要同时启动多个 `work`/`watch` 进程，也不要在
两台电脑上同时运行 Harness。

### 分阶段命令

这些命令各自有明确停止点，不是单个端到端命令。

| 命令 | 说明 |
|---|---|
| `pnpm harness work --once` | 重新检查后执行一个自动协调动作；绝不执行显式恢复 |
| `pnpm harness run-once` | 领取 issue、创建或复用 worktree、完成实现；不 push、不建 PR |
| `pnpm harness audit-once` | 运行独立 Pi audit，必要时执行受控 rework；不建 PR |
| `pnpm harness publish-once` | audit 通过后 push 并创建或复用 PR，停在 `awaiting_merge` |
| `pnpm harness wait-merge --timeout-minutes 60` | 轮询 GitHub；auto 模式请求 GitHub 自动合并，绝不直接 merge |
| `pnpm harness recover --dry-run` | 只读显示崩溃后应恢复的 ensure step |
| `pnpm harness recover --execute` | 执行已核对的恢复步骤 |
| `pnpm harness status` | 显示 active job、最近 job 与 Orca 状态 |

### 统一 Work 入口与前台 Watch

`work` 是统一协调器入口。它在每个 cycle 前重新检查事实，每个 cycle 最多执行一个
自动动作；遇到稳定状态、`awaiting_merge`、失败或需要显式恢复的动作就停止。使用
`--once` 可限制为一个 cycle。

```bash
pnpm harness work --once
pnpm harness work --repo OWNER/REPO --max-cycles 10 --poll-seconds 30
pnpm harness work --dry-run --once
```

> **注意：`watch` 是主动的兼容控制器，不是被动 merge monitor。** 没有 active
> job 时，它可以领取下一个带配置标签且未阻塞的 issue；后续 tick 可以派发 agent、
> 运行 audit，并 push 和创建 PR。

```bash
pnpm harness watch
pnpm harness watch --once
pnpm harness watch --dry-run --once
pnpm harness watch --max-cycles 10 --poll-seconds 30
```

当前 `watch` 只以前台进程运行；关闭终端或进程退出后就不再监控。默认轮询间隔
来自 `pollIntervalSeconds`（当前默认 120 秒）。`SIGINT` 和 `SIGTERM` 会让它在
当前周期结束后退出。

每个 `watch` tick：

1. 对账 active job，与 `recover` 使用相同事实源。
2. 最多执行一个自动协调动作：`run-once`、`audit-once`、`publish-once` 或一次
   `wait-merge` poll。
3. 没有 active job 时，尝试领取并实现下一个 eligible issue；后续 tick 重新检查后
   才执行 audit，不在同一 tick 串联。
4. 遇到显式恢复动作时停止；操作员必须先运行 `recover --dry-run`，再运行
   `recover --execute`。
5. PR 被 GitHub 或人工合并后，下一次 poll 记录 `mergedAt` 并释放 ledger 单槽，但保留 Orca
   worktree 供检查。
6. `blocked` job 继续占槽；CI 失败或 requested changes 不会在等待合并阶段自动
   触发 rework。
7. auto 模式只请求 GitHub 自动合并；绝不直接 merge，也不自动删除已完成 worktree。

### launchd 常驻服务（延后）

本仓库当前**没有** launchd plist，也没有 install/start/status/uninstall 服务命令，
不会安装或启动常驻 watcher。正式部署仓库启用前，请继续使用前台
`pnpm harness watch`。

未来启用 launchd 时，至少必须满足以下条件：

- 固定 Node 可执行文件、仓库工作目录和构建后的 CLI 路径。
- 显式提供 `HOME` 与稳定的 `PATH`，确保 `gh`、`git`、`orca` 和 `pi` 可用。
- 在加载服务前运行 `doctor`，提供 stdout/stderr 日志，并验证单实例与卸载流程。
- 在启用登录启动和崩溃重启前，验证 `bootout` 能在同步 poll sleep 期间及时退出；
  当前信号处理可能延迟到最长一个 poll interval。
- 禁止与手工启动的 foreground watcher 并跑，不在 plist 中保存 token，并为日志
  设置轮转策略。
- 明确继承上面的完整 `watch` 行为，包括已配置的 GitHub 自动合并策略，且不删除
  worktree。

## 恢复与可靠性

Controller 崩溃后不要直接领取新 issue。`recover` 是显式恢复兼容 adapter；即使
使用 `--execute`，没有 active job 时也不会领取新 issue。先执行：

```bash
pnpm harness recover --dry-run
pnpm harness recover --execute
```

| Ledger 状态 | 恢复动作 |
|---|---|
| `claimed` / `worktree_ready` / `implementing` | `run-once`：复用 worktree；已有提交时核验后完成，不重复等待 |
| `awaiting_audit` / `auditing` / `reworking` | `audit-once`：只复用同轮、同 SHA、来源完整的结果 |
| `audit_passed` / `publishing` | `publish-once`：按 head 查找并复用 PR |
| `awaiting_merge` | `wait-merge`：轮询；auto 模式请求 GitHub 自动合并并记录结果 |
| 可恢复的 blocked audit | `audit-once`：重新经过正常 gate |
| 无提交的 ended implementation | 仅显式 `recover --execute` 才在原 worktree 重派 |
| 其他 `blocked` | 不继续，持续占槽 |
| `merged` / 无 active job | 可安全领取下一项 |

不得手工编辑 ledger，也不得用临时脚本直接接受
`.harness/audit-result.json`。Audit 只能通过 `audit-once` 或
`recover --execute` 回到严格 gate。

在领取前，`run-once` 刷新配置的 remote-tracking `baseRef`，固定完整 SHA，并要求
Orca worktree HEAD 精确匹配。Dispatch 前要求 TUI idle，dispatch 后探测 task id
或新的 Working 信号；`worker_done` 必须匹配当前 task 和已记录的 dispatch id。

## 当前 Pi 角色

```yaml
activeProfiles:
  implementer: pi-implementer
  auditor: pi-reviewer
```

| 角色 | Profile | 权限与职责 |
|---|---|---|
| Implementer | `pi-implementer` | 使用 `read,edit,write,bash,subagent` 实现、测试、提交和 rework，并运行隔离的内部双轴 review |
| Auditor parent | `pi-reviewer` | 不得修改 tracked files 或 HEAD；可写唯一 gate 证据 `.harness/audit-result.json` |
| Internal reviewer | `harness-reviewer` | fresh user scope、无 artifacts，只向 parent 返回 Standards 或 Spec 报告 |

Implementer 显式加载 controller-owned Matt `implement` 与 `tdd`（固定到
[`ed37663`](https://github.com/mattpocock/skills/tree/ed37663cc5fbef691ddfecd080dff42f7e7e350d)）
以及 Pi-adapted `code-review`。它只加载 Orca prefill/status 和已批准版本的
`pi-subagents`；不加载 ReadSeek。自动 skill、extension、prompt-template 与
project Pi resource discovery 均关闭，但仍读取仓库 `AGENTS.md` /
`CLAUDE.md`。

Pi CLI 与固定版本的 `pi-subagents` 安装在项目 `node_modules`，随
`pnpm install --frozen-lockfile` 更新；provider 凭证和 Orca-managed extensions 仍保留
在用户目录，不进入仓库。

Implementer 和 auditor 当前仍共享父 Pi provider/model 与
`PI_CODING_AGENT_DIR`；角色级 provider/config 隔离尚未实现。Internal reviewer
通过 wrapper 移除 parent 的 Orca lifecycle handles。

> Pi 的 tool allowlist **不是 OS sandbox**。特别是 `bash` 与 TypeScript
> extensions 仍拥有 Pi 进程的文件系统、凭证和网络权限，真正隔离必须在 Pi
> 外部完成。

## 硬约束

1. Agent 不得创建、添加或移除 GitHub labels。
2. 全局最多一个 in-flight issue；只有 merge 或显式取消后才释放。
3. 只有 implementer 可修改 tracked product files；auditor 仅可写 gate artifact。
4. 独立 Pi audit 通过前不得创建 PR。
5. PR merge 前不得领取下一项。
6. Closed-unmerged、audit exhausted 或 issue revoked 必须进入 blocked，不能跳过。
7. 不得直接 merge 或自动删除完成的 worktree；auto 模式只能请求 GitHub 自动合并。

## 配置、状态与决策

- 配置：[`config/harness.yaml`](config/harness.yaml)
- 业务状态：`data/harness.sqlite`
- 运行日志：controller 前台输出与 Orca terminals
- 架构决策：[`docs/decisions.md`](docs/decisions.md)

Orca 是唯一执行层，负责 worktree、terminal、dispatch、task 与
`worker_done`；业务状态以 SQLite ledger 为准。
