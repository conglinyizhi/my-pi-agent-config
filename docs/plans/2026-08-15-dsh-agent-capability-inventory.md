# DSH Agent 能力层盘点报告（v0.1.0-rc.6）

> 调查基线：`~/.cache/pnpm/dlx/…/node_modules/.pnpm/@deepseek-ai+dsh-*@0.1.0-rc.6_*`（只读）。
> 方法：逐一读取各包 `README.zh.md` + `lib/` 结构，并以本机实际磁盘数据（`~/.dsh/`、bundled preset 文件、会话 JSONL 日志）交叉验证。
> 目的：为 pi coding agent（TS 模块 + registerTool/registerCommand/事件钩子）做能力对表。

**关键澄清（先看这里）**：`@deepseek-ai/dsh-client-modules` **不是** goal/workflow/subagent 等能力模块的宿主。它是浏览器侧模块加载器（Node 内部 ESM loader 的浏览器端对等实现：惰性 CJS 表、`window.__DSH_BOOT__` 模块图、HMR 的 prefetch/invalidate 钩子），模型体验为零。能力模块各自独立成包，且普遍按「seam（抽象服务）＋实现插件＋面向模型工具＋面向人类命令＋浏览器 UI」五件套拆分。

---

## A. 能力总表

| 能力 | 所属包（核心） | 是什么（一句话） | 对外暴露形态 | 状态持久化方式 |
|---|---|---|---|---|
| **goal 领域** | `dsh-goal`（服务） | 同会话「当前目标」状态机（事件溯源，CAS 防护） | `ctx.goals` 服务动词 `create/edit/pause/resume/complete/block/clear`；Host Remote `goals.*` | 每次变更追加持久 `goal/change` 事件（含完整快照；clear 用带 revision 的 tombstone）→ 会话 JSONL 日志是唯一权威 |
| goal 模型工具 | `dsh-tool-goal` | goal 的面向模型控制 | LLM 工具 `get_goal` / `create_goal` / `update_goal` | 无独立存储（读写上面的事件） |
| goal 用户命令 | `dsh-command-goal` | 人类 `/goal` 控制 | 命令 `/goal [objective\|edit\|pause\|resume\|clear]`（经 `ctx.commands`） | 同上（`goal/change` 记录） |
| goal 续行驱动器 | `dsh-goal-round-driver` | 把 active+armed 目标转成连续 Goal Round 自动推进 | 服务/事件驱动（`agent/idle` 检查点 + `<goal_round>` 提示词 + 准入 `roundsStarted+1`） | 无独立持久化；Round 计数并入 `goal/change`；激活状态仅进程本地 |
| goal UI | `dsh-client-ui-goal` | GoalBar 横条（编辑/暂停/恢复/清除） | 浏览器插件 + `ctx.remote.goals` RPC | 只读 `goal` 投影（历史尾页播种 + `session/projection` 帧） |
| **workflow** | `dsh-workflow`（seam）+ `dsh-workflow-worker-thread`（引擎） | 模型编写 JS 编排脚本、扇出 subagent 的扩展点 | `ctx.workflowEngine.start(request)`；`workflow/start|end|phase|log|agent-start|agent-end` 事件 | 运行**不持久化**（无 checkpoint、无恢复）；仅 log-only 的 `workflow/run-start` / member 事件写父会话日志 |
| workflow 模型工具 | `dsh-tool-workflow` | 面向模型的 `workflow` 工具 | LLM 工具 `workflow(meta, script, args?)` → `{runId, agentsStarted, result}` | 同上 |
| **subagent** | `dsh-subagent`（seam）+ `dsh-subagent-spawn-in-process` / `-fork-in-process` / `-in-process-driver` | 经具名提供方委派子 agent（one-shot / continuable / fork） | `ctx.subagents` 服务：`start / startContinuable / followup / interrupt / reportFrom / listChildren / listDescendants` | 每个子 agent 是**独立 Session**（JSONL 日志）；header 记 `delegationDepth`、`agentPreset`、`parentSession`；continuable 有持久描述符 |
| subagent 模型工具 | `dsh-tool-subagent` | 面向模型的委派工具 | LLM 工具 `subagent(prompt, description?, run_in_background?)`（`toolName` 可配）；fork 用另一实例 | 同上 |
| subagent 控制工具 | `dsh-tool-subagent-control` | 全局父子控制 | LLM 工具 `send_message(subagent_id, message)` / `interrupt_agent(agent_id)` / `list_agents(scope?)` | 无（读在线注册表 + 持久 header） |
| subagent 上报工具 | `dsh-tool-subagent-report` | 子→父 返回通道（仅 continuable 子级作用域） | 子级 LLM 工具 `report(output)` | 无（投递为父会话的后续消息/inject） |
| **plan mode** | `dsh-plan-mode` | 按 agent 的「只规划不执行」软引导协作状态 | `ctx.planMode.set/get`；命令 `/plan [message]`、`/plan off`；LLM 工具 `exit_plan_mode`；`plan:policy` 提示词段（order 50） | `plan/mode` 事件（`{active}` 全量替换）入日志；`plan` 投影单元从日志折叠 |
| plan UI | `dsh-client-ui-plan` | Plan 状态徽章 | 浏览器插件（只渲染投影 + 派发 `/plan off`） | 无（读 `plan` 投影） |
| **trajectory** | `dsh-client-ui-trajectory` | 按轮次组织的会话事件时间线（token/耗时/输入输出） | **纯浏览器视图**（无服务、无模型暴露、无 RPC） | 无自有存储；只读会话事件（JSONL / `session/event` 帧） |
| **jobs** | `dsh-jobs`（seam）+ `dsh-jobs-local`（实现） | 后台长任务注册表（owner 隔离、读取、取消、等待、通知） | `ctx.jobs` 服务：`start/get/list/read/kill/wait/onJobDone/onJobsChanged/attachController` | **进程内内存**（重启即失）；无持久化；完成投递 `reported` 位亦内存态 |
| jobs 模型工具 | `dsh-tool-jobs` | 面向模型的 job 控制 | LLM 工具 `job_output(job_id, wait?, timeout_ms?)` / `job_list()` / `job_kill(job_id, reason?)` + 完成通知 | 同上 |
| jobs UI | `dsh-client-ui-jobs` | 会话 Header 的任务列表弹层 | 浏览器插件（读 `jobsBySession` 镜像） | 无 |
| **presets** | `dsh-agent-presets` | 按 preset 组装 agent（工具/提示词/投影的分层归属） | `ctx.agentPresets` 服务：`list/resolve/mount/composeFrom/recompose/read/copy/remove/…`；Host Remote `agentPreset.list/select/read/copy/remove` | **文件系统**：preset 目录（`agent.cordis.yml`+`preset.yml`）；会话 header 记 `agentPreset` + `agent-preset/selected` 事件 |
| preset UI | `dsh-client-ui-agent-preset` | 预设选择器 | 浏览器插件 | 无 |
| **system prompt** | `dsh-system-prompt` | 有序段 + 工具 schema + 变量的提示词组装注册表 | `ctx.systemPrompt.section/context/tools/variable/assemble`；`system-prompt/assemble` waterfall | 不持久化；每请求组装；`complete` 段可整体取代 |
| todo | `dsh-tool-todo` | agent 任务列表（每次整体替换） | LLM 工具 `todo_write(todos: [{content, status}])` | `todo/write` 事件（全量快照，last-wins）入日志 |
| 提问 | `dsh-tool-ask-user` + `dsh-user-questions` | 模型向用户提问 | LLM 工具 `ask_user_question(questions)`；Host `userQuestions.*` Remote | 问答通道（`user/questions` 事件） |
| ralph | `dsh-tool-ralph` | 固定工作流：不可变目标交给全新子 agent 迭代 | LLM 工具 `ralph(objective, maxRounds?)` | 无独立存储（基于 workflow/subagent） |
| web | `dsh-tool-web` + `dsh-web-search-deepseek` | 联网搜索/抓取 | LLM 工具 `web_search(query)` / `web_fetch(url)` | 无 |
| code mode | `dsh-code-runtime-worker-thread` + `dsh-agent-tool-presentation` | 模型写 TS 程序、一次执行多步 | LLM 工具 `run_code`（生成 SDK + Code Mode 呈现） | 无（worker 每次全新） |
| 会话统计 | `dsh-session-stats` | 全会话轮/步/LLM 耗时统计 | `sessionStats` 投影单元（只读读模型） | 由 session-projection 折叠事件；可被 `session_projcache` 持久化 |
| 投影框架 | `dsh-session-projection` | 事件→读模型的状态驱动计算 | `ctx.sessionProjections.register/onChanged/snapshot` | 纯计算；`apply/init/view` 同步、全量值 last-wins |
| 投影缓存 | `dsh-session-projection-cache` | 投影检查点持久化（折叠捷径，非权威） | `ctx.sessionProjectionCache.cachedSnapshot/coldSnapshot/write` | storage-domain `session_projcache`（`~/.dsh/storages/session_projcache.json`，行 `{ver,seq,val}`，绑定 header 身份） |
| 消息反馈 | `dsh-message-feedback` | 单条 assistant 消息的可编辑反馈（赞/踩+备注） | `ctx.messageFeedback` + Host Remote `messageFeedback.list/put/delete` | storage-domain `message_feedback`（每 Session 一行，绑定 `{createdAt,cwd}` 身份） |
| 日志导出 | `dsh-session-log-export` + `dsh-host-apiproxy` | 会话日志 ZIP 下载 | Host 流式端点 `GET /api/session.export?sessionId&includeDescendants` + 命令 `/export` | 无（读 JSONL/zstd 原始日志） |
| workspace | `dsh-workspace` | workspace 实体注册表 + 会话分组/归档 | `ctx.workspaceRegistry.create/get/list/delete/insertBefore/archiveSession…` | storage-domain `workspace`（`~/.dsh/storages/workspace.json`） |
| 宿主 RPC/事件网关 | `dsh-host-apiproxy` + `dsh-client-connection` + `dsh-api-remotes` | 客户端↔宿主的 RPC 与事件通道 | HTTP `POST /api/<method>`（`RpcMethodMap`）+ WebSocket `events.mux`/`events.host` + Typert `ctx.remote` | 无（传输层）；trustedHosts 回环栅栏 |
| Web 服务器 | `dsh-host-webserver` | HTTP/upgrade 路由注册 | `ctx.webServer.register/registerUpgrade/registerFallback/tapIndex` | 无 |
| shell 环境 | `dsh-shell-env` | 受信任 `DSH_*` 环境变量收集 | `ctx.shellEnv` 注册表（contributor 可扩展） | 每次 shell 调用现场收集；无持久化 |
| 运行时不变式 | `dsh-invariants` | 包自检不变式注册表 | `ctx.invariants.register(packageName, installer)`；各包 `./invariant` 配套入口 | 无（fail 即 `InvariantError`） |
| Agent 核心 | `dsh-agent`（接口/注册表）+ `dsh-agent-loop`（唯一循环实现） | Agent handle、`agent/*` 事件、会话/轮次/步骤生命周期 | `ctx.agents` / `ctx.agentLoop` | **会话 JSONL 日志是唯一持久权威**（`~/.dsh/sessions/<cwd-slug>/<sessionId>/session.jsonl.zstd`） |

---

## B. 五大能力详解

### B1. Goal

**核心概念**：同会话唯一「当前目标」。状态机持久化在会话日志里（事件溯源），进程本地另有不持久化的「续行激活（armed）」位——resume/fork 后目标仍在但自动工作不会重启，须显式 resume 重新武装。`GoalRef {id, revision}` 做 compare-and-set 防护，陈旧引用被拒。单一 phase 词汇：`active / paused / completed / blocked`（blocked 附策略代码 + 自由文本）。目标**只负责状态，不负责任务调度**；续行由驱动器消费。

**状态机/数据流**：
- 变更动词：`create`（revision=1, phase=active, 武装续行）→ `edit`（保 phase/blocker/activation）→ `pause` / `complete` / `block` / `clear`（均解除武装；clear 留 tombstone）→ `resume`（仅当 Round 预算有剩余；清 blocker）。
- 每次变更追加 `goal/change` 事件（携带变更后完整快照）；严格回放校验：形状、revision 连续、生命周期转换合法、时间戳单调、Round 准入连续。
- 续行驱动器：agent idle 检查点 → 若 active+armed+有容量 → 预留 `roundsStarted+1` → 排入 `<goal_round>` 用户消息（含 JSON 引用的目标 + `round/maxGoalRounds`）→ 该 `user/message`（来源 `GoalMessageSource`）经 `agent/pre-step` 准入时 `roundsStarted++`。人类消息不消耗 Round。
- 自动 Round 由模型通过 `update_goal` 报 `complete`/`blocked` 结束（`concludeTurn()` 停轮）；`blocked` 在 `blockedAfterConsecutiveRounds`（默认 3）前被机械拒绝。

**对外 API**：
- 服务：`ctx.goals.create/edit/pause/resume/complete/block/clear`（`GoalRef` CAS）。
- 工具（`dsh-tool-goal`）：
  - `get_goal()` → `{goal: null}` 或 `{goal: {id, revision, objective, phase, roundsStarted, maxGoalRounds, blockedReason?}, activation}`
  - `create_goal(objective, max_goal_rounds?)`
  - `update_goal(goal_id, revision, action, objective?, max_goal_rounds?, blocked_reason?)`，`action ∈ {edit, pause, resume, complete, blocked}`（`blocked_reason` 仅 blocked 必填，代码固定 `model-reported`）
- 命令：`/goal`、`/goal <objective>`、`/goal edit <objective>`、`/goal pause|resume|clear`。
- 权限：create/edit/pause/resume 要求轮次内存在人类 `{kind:'user'}` 消息或 steering 事件；**subagent 执行一律被拒**；complete/blocked 要求匹配当前 Goal Round。

**持久化**：会话 JSONL（`~/.dsh/sessions/…/session.jsonl.zstd`）中的 `goal/change` 事件；激活状态绝不落盘。UI 侧另有 `goal` 投影 + `session_projcache` 缓存行。

**移植要点**：领域逻辑（服务+工具+权限）与 DSH 会话模型强耦合，但事件溯源模式可直接照搬——把 `goal/change` 换到 pi 自己的会话持久层即可；驱动器依赖 agent idle 检查点与「user 来源消息」语义，pi 需在 loop 的 idle 钩子里等价实现。

---

### B2. Workflow

**核心概念**：模型编写纯 JS 编排脚本（扇出 subagent、分阶段），由引擎在隔离环境执行并返回最终 JSON 值。seam（`ctx.workflowEngine`）定义 `WorkflowStartRequest / WorkflowRun / WorkflowResult / 事件` 契约；引擎实现可替换（当前 `dsh-workflow-worker-thread`：每次运行一个 Node worker thread，脚本在 `node:vm` 内执行——**是隔离不是安全边界**，信任立场与 bash 等价）。

**状态机/数据流**：
- `start()` 先做同步校验（meta 形状、脚本可解析、provider 路由、`maxTotalAgents` 上限），再起 worker；`run.result` 永不 reject——失败以 `stopReason:'error'`、取消以 `'cancelled'` 兑现。
- 脚本钩子：`agent(prompt, {label, phase, schema?, model?})`（启动宿主侧 subagent，提供 schema 返回结构化值，普通失败返回 null）、`parallel(thunks)`、`pipeline(items, ...stages)`（无跨阶段屏障）、`phase(title)`、`log(message)`、全局 `args`。
- worker↔宿主协议：`child-start` → 宿主 `SubagentRuntime.start`（provider 对脚本不可见）→ `child-started` → 成对 `workflow/agent-start|end` → 收集后 dispose。
- 致命错误（`WorkflowError` 带 code+fatal）会逸出 `parallel/pipeline`，不降级为 null：`SCRIPT_PARSE / META_INVALID / INVALID_ARGUMENT / UNSUPPORTED_OPTION / UNSUPPORTED_SCHEMA / AGENT_CAP / ITEM_CAP / AGENT_START / AGENT_RESULT / RESULT_UNSERIALIZABLE / CANCELLED`。
- 值边界：跨 realm 值经无损 JSON 验证（拒绝函数/symbol/循环/稀疏数组/非有限数/嵌套 undefined；`__proto__` 不能改原型）。
- 配置：`provider`（默认 `spawn`）、`maxConcurrentAgents`（0=按 CPU 并行度）。

**对外 API**：
- 服务：`ctx.workflowEngine.start({meta, script, args?, subagentProvider?, maxTotalAgents?, parent, signal?}) → WorkflowRun{id, meta, result, cancel(reason?), dispose()}`；`WorkflowResult{value, stopReason, error?, agentsStarted}`。
- 工具（`dsh-tool-workflow`）：`workflow(meta: {name, description, phases?}, script: string, args?: object)` → `{runId, agentsStarted, result}`；配置 `toolName`（默认 `workflow`）、`maxResultChars`（默认 50000）。系统提示词指导「仅当用户明确要求 workflow/大型编排时才用；一两项委派优先 subagent」。
- 事件（仅观察）：`workflow/start|end|phase|log|agent-start|agent-end`（payload 带 `WorkflowRunInfo{id, meta}`，监听器拿不到取消/dispose 权）。
- 根 transport 执行时写 log-only 会话记录：`workflow/run-start`、`workflow/run-member-start/end`、`workflow/run-end`。

**持久化**：运行本身**无 checkpoint 无恢复**（明确限制：进程重启无法继续）；父会话日志里的 `workflow/run-*` 记录仅供 UI 展示（invariant 校验配对：拒绝重复 start、未配对成员、run-end 后更新）。

**移植要点**：seam 分层（契约/引擎/工具）值得照抄；worker-thread 引擎可直接移植（依赖 `ctx.subagents` 与 worker 协议，pi 的 subagent 运行时若提供 `start(prompt, opts)` 即可对接）。「脚本由模型编写」= 模型既是工具使用者也是代码作者，信任边界要写清楚。

---

### B3. Subagent

**核心概念**：一个 agent 经具名提供方向子 agent 委派工作。调用方统一走 `ctx.subagents`；提供方决定子 agent 在哪里跑。三种模式：
- **one-shot**：前台 `start()` 等 `run.result` 并 dispose；或后台注册为父级所有的普通 Job（返回 `{kind:'background', jobId}`）。
- **continuable**：持久化可继续子 agent，`startContinuable(spec)` 在 inbox 接受时即返回 `{childId, messageId}`；后续 `followup(parent, childId, content, {source, signal})` 作为其下一 FIFO 轮次；`interrupt` 凭人类持久父级地址或在线祖先 Agent 授权；子级 `reportFrom` 回投父级（`wakeup`=开新父轮次 / `quiet`=注入上下文）。
- **fork**（`dsh-subagent-fork-in-process`）：以父 agent **已完成轮次前缀**（截至最后一个 `turn/end`）为初始内容；进行中的轮次不可见。
- 深度：`delegationDepth` 持久化在子会话 header，`maxDepth` 默认 3；spawn/fork 均声明 `{outputSchema, depthLimit, toolFilter, persona}` 能力。
- 子 agent 拥有**全新扁平注册作用域**：不继承父的工具限制/权限；结果读取 = 最后一条非空 assistant 消息 + 最终持久轮次原因（排除 fork 种子）。

**数据流**（in-process driver `startInProcessRun`）：校验深度 → `parent.ctx.agents.create`（创建事务）→ 未发布窗口装 persona/toolFilter/结构化输出 → 发布 → `child.followup(prompt)` → `child.whenIdle()` → 读结果 → 取消/深度/定制/dispose 全共享。发布前 abort 回滚且不留下半成品；发布后 abort 取消子 agent。

**对外 API**：
- 服务：`ctx.subagents.start(name, request)` / `startContinuable(spec)` / `followup(...)` / `interrupt(targetSessionId, authority)` / `reportFrom(child, content, {delivery, signal})` / `listChildren(parentSessionId)` / `listDescendants(rootSessionId)` / `registerProvider` / `registerContinuableSetup` / `drainContinuableDescendants`。
- 工具：`subagent(prompt, description?, run_in_background?)`（默认 provider 绑定；one-shot 默认前台，continuable 默认后台）；`send_message(subagent_id, message)`（成为下一轮次，不返回回答）；`interrupt_agent(agent_id)`（只停当前轮次 keepInbox）；`list_agents(scope?: 'children'|'descendants')`；子级作用域 `report(output)`（无接收方参数，父由持久 header 推导）。
- 提供方注册名：`spawn`、`fork`（standard preset 另挂 `codex`、`claude-code` 外部提供方实例）。

**持久化**：子 agent = 独立 Session（JSONL）；header 含 `delegationDepth`、`agentPreset`（子级加入父级 preset 常驻组装）、`parentSession`（followup/report 的授权凭据）。continuable 描述符持久化；one-shot 后台形态在父侧仅一个 Job 注册（内存）。

**移植要点**：这是 DSH 里移植价值最高的能力之一。seam API 与 pi 当前 subagent 工具形态几乎一一对应（pi 的 `subagent`/`send_message`/`interrupt_agent`/`list_agents`/`report` 就是它的直接映射）；需补的机制：深度预算持久化（header）、fork 种子（已完成轮次前缀）、continuable 冷恢复（父级存在性鉴权）、后台 Job 化。

---

### B4. Plan mode

**核心概念**：按 agent 记录的「规划协作状态」，**软引导**——sandbox/批准策略各自强制限制，plan 状态不读写它们。进入/退出路径：`/plan [message]`、`/plan off`、或模型侧 `exit_plan_mode`（须经 `ctx.userQuestions` 获人类明确批准，`plan-review` 呈现意图 + `Approve` 标签）。

**状态机/数据流**：
- 持久状态即 `plan/mode` 事件（`{active: boolean}`，每次全量替换，仅存于日志）；`foldPlanMode(events)` 折叠出最后值——恢复/fork/压缩都能从日志还原。
- `ctx.planMode.set(agent, active)`：agent 空闲立即追加事件；运行中则「待生效（pending）」保留到下一个被接受的轮内 pre-step。返回值：`committed | queued | cancelled | noop`。
- 激活时系统提示词顺序 50 渲染部署配置的 `section`（即 `plan:policy` 段）；非激活不贡献文本。
- `plan` 投影单元：折叠 `plan/mode` 事件 + `command/run`（名为 `plan` 的斜杠命令设置目标态 `off→false`），`view` 推导 `{active, pending}`。
- `/plan <非off参数>` 会先启用 plan mode 再 `agent.steer()` 提交为普通用户消息。

**对外 API**：
- 服务：`ctx.planMode.set(agent, active)` / `get(agent) → {active, pending?}`。
- 工具：`exit_plan_mode`（execute 仅接受已激活模式 + 用户批准；schema 常驻保持工具目录稳定）。
- 命令：`/plan [message]`、`/plan off`。
- 配置：`section`（必填非空；策略文本原样进入提示词）。

**持久化**：`plan/mode` 事件入会话日志（全量 `{active}`）；`plan` 投影 + `session_projcache` 缓存。

**移植要点**：状态机很小很干净，`plan/mode` 事件 + 投影模式可直接复制。移植时两点要重做：① `ctx.commands` 斜杠适配器（TUI 需自己的命令平面）；② `ctx.userQuestions` 评审通道（TUI 需自己的提问 UI）。「软引导」与「沙箱强制」分离的设计值得照抄。

---

### B5. Trajectory

**核心概念**：**纯浏览器读模型**——按轮次组织的会话事件时间线（用户/助手/工具/嵌套子工具记录；token、TTFT/解码耗时、输入输出、计时；compaction 区段）。**该包不提供 service、不声明 Context 合并、不发任何 RPC、零模型暴露**。数据全部来自共享 Session 窗口的事件组装（含取消冻结的助手/工具记录），因此既不读也不改 Chat 会话快照。

**状态机/数据流**：无状态机。事件流驱动：`session/event` 帧 + 历史尾页；虚拟化长表只挂载可见行窗口；Overview 时间域（真实开始时间+耗时，hover 500ms 精确值）；拖选区间聚焦、滚轮缩放、向上滚动暂停跟随；已完成回复在 target State 保留组装 blocks，共享窗口保留原始 Event。

**对外 API**：无（无工具、无命令、无服务）。依赖：会话壳把 composer 作浮层、`conversation.view` slot 环注册视图标签页、api-contracts v3 §8 约定。

**持久化**：无自有存储。真源是会话 JSONL（`session.jsonl.zstd`）+ 实时事件帧。

**移植要点**：轨迹数据 = 会话事件流 + 投影（`session-stats` 提供的 TTFT/decode/tool 耗时折叠字段名与轨迹共用）。TUI/CLI 若要「轨迹」能力：**后端逻辑零改动可复用**（事件日志、`sessionStats` 投影、`session_projcache` 冷读），UI 层需按终端形态重写（轮次列表 + 每轮 token/耗时 + 工具调用展开）。

---

## C. Preset 机制

**文件格式**（实测 bundled 数据：`@deepseek-ai/dsh/config/agent-presets/{standard,code,minimal,cordis}/`）：
```
<preset-dir>/            # id = 目录名（[a-z0-9][a-z0-9-]*）
  agent.cordis.yml       # 必需：agent-plane 插件行列表（装配文本）
  preset.yml             # 可选：仅展示元信息
  skills/ assets/ …      # 随目录迁移的附属内容（copy 时整体复制）
```
- `preset.yml` **只承载展示文本**：`name` / `description` / `order`（排序）。id 与 trust 不可写在这里（防本地 preset 自封进随附集合）。
- `agent.cordis.yml` 是具名插件行的顶层列表（Loader 方言，支持 `!!js` 表达式如 `disabled: !!js process.platform === 'win32'`）。**绝对关键的行内约定**：需要发布服务（如 terminal/fs 域）的行必须放在 `cordis:group` + `isolate: <realm>` 组里，否则服务进 root realm 与其他 preset 冲突（`dsh-agent-presets` 挂载时拒绝）。
- 行解析：包名从**宿主组装**解析（非 preset 目录——用户根目录下 Node 找不到 harness 的 node_modules）；相对路径从 preset 自身目录解析；绝对路径转 `file:` URL。

**实测内容**（standard preset 的装配行，即「完整编码 agent」= 各能力在 preset 层的挂载清单）：
`persona`（含 `{{model}}/{{cwd}}` 变量）、`agent-instructions`（AGENTS.md）、`tool-bash`/`tool-pwsh`、`tool-fs`/`tool-fs-search`、`tool-jobs`、`skill-filesystem`+`tool-skill`、`tool-goal`、group `plan-mode`（isolate planMode）、group 压缩栈（`compaction-basic`+`command-compact`+`tool-result-pruner`）、group subagent（`tool-subagent-control`+`list-agents`+`tool-subagent`(spawn/fork/codex/claude-code 四实例)）、group workflow（`workflow-worker-thread`+`tool-workflow`+`tool-ralph`）、`tool-ask-user`、`tool-todo`、`tool-web`。
（minimal preset 只留 `persona(complete:true, includeRuntimeContext:false)` + persistent bash + str_replace_editor——两条注释明说「persona 即完整系统提示词」「模型只写 bash 和 str_replace_editor」。）

**实际磁盘数据对照**：bundled presets 在上；`~/.dsh/.agent-presets/`（用户根，trust=user）**当前为空**——本机没有用户创作 preset。会话证据：`agent-preset/selected` 事件实测 `{"type":"agent-preset/selected","seq":3,...,"data":{"agentPreset":"code"}}`，session header 首行 `{"type":"session","version":0,...,"agentPreset":"standard"}`——**header 冻结创建期事实，实际运行的 preset 以 `agent-preset/selected` 事件（+resolveSessionPreset 解析）为准**。

**加载逻辑**（`ctx.agentPresets`）：
- 发现不缓存：`list()/resolve()` 每次重读根目录；坏目录（YAML 不可解析/非插件行列表）作为 `broken` 行列出而不跳过；目录名不合 id 规则才直接跳过。
- 挂载模型：`mount(agentCtx, id)` 确保**进程内一次常驻挂载**（standing scope，own fiber），agent 的 scope key 经 `dsh-scope` **认父**到该挂载 → 视图按 `agent → preset → global` 解析（近者遮蔽远者）；subagent 用 `composeFrom()` 认父加入父方常驻组装（同步，绝不 mount）。
- 代际：每个代际记录组装文件 stamp（mtime+size）；文件被编辑后新会话进入下一代，已在运行的会话保持旧代际。
- `recompose()`（换 preset）仅对「尚无任何产出」的 agent 合法（产品锁，网关层以 `agent-preset-locked` 拒绝）；先装新再拆旧，失败回滚。
- 创作即复制：`copy(from, id, name?)` 整目录复制到首个 user 根，`0o600/0o700` 收紧、symlink 解引用、`preset.yml` 丢弃 name/order；`remove()` 拒随附 preset。

**与系统提示词的关系**：preset 不直接写提示词——它的 `agent.cordis.yml` 行（如 `persona`、`plan-mode` 的 `section`、各工具的 `tool:*` 指导段）注册进 **preset scope 层**的 `ctx.systemPrompt` 与 `ctx.tools`；`dsh-system-prompt` 按调用方上下文 scope 分层归档，装配时 `agent → preset → global` 合并。所以 **preset 决定模型的工具目录与提示词段落**（这正是「preset 选择必须能由日志重建」的原因：`agent-preset/selected` 事件被记录）。persona 支持 `complete: true`（装配后成为精确完整提示词）与 `includeRuntimeContext: false`（抑制动态上下文）。

---

## D. 前端依赖 vs 后端可复用（移植到 TUI/CLI 的对表）

### 纯前端、必须重写 UI 层（后端逻辑可原样复用）
| 能力 | 前端包 | 后端可复用部分 |
|---|---|---|
| trajectory | `dsh-client-ui-trajectory` | 会话事件流、`sessionStats` 投影、`session_projcache` 冷读 |
| goal UI | `dsh-client-ui-goal`（GoalBar） | `ctx.goals` 服务、`goals.*` Remote、`goal` 投影 |
| plan UI | `dsh-client-ui-plan`（徽章） | `dsh-plan-mode` 服务/命令/工具/投影 |
| jobs UI | `dsh-client-ui-jobs`（列表） | `ctx.jobs`、`job_output/list/kill` |
| subagent UI | `dsh-client-ui-subagent`（目录） | `ctx.subagents.listChildren/listDescendants`（**服务明确不依赖 GUI，TUI 可直接调**） |
| preset UI | `dsh-client-ui-agent-preset`（选择器） | `ctx.agentPresets.list/resolve/copy/remove` + `agentPreset.*` Remote |
| 会话统计条 | `dsh-client-ui-*`（消费 `sessionStats` 投影） | `dsh-session-stats` 折叠单元 |

### 后端/agent 核心逻辑，移植时可直接复用（把「命令/Remote/提问」适配到 TUI 通道）
| 能力 | 可复用内容 | 需适配的 UI/通道 |
|---|---|---|
| goal | 领域服务 + `dsh-tool-goal` + `dsh-goal-round-driver` | `/goal` 命令适配器（`ctx.commands`）；GoalBar 换成 TUI 展示（可选） |
| workflow | seam + worker-thread 引擎 + `dsh-tool-workflow` | 无（纯模型工具 + 事件）；运行结果渲染换 TUI 卡片 |
| subagent | seam + in-process 提供方 + 全部工具（subagent/send_message/interrupt/list/report） | 无（纯服务+工具）；后台 Job 通知需 TUI 通知通道 |
| plan | `dsh-plan-mode` 服务/工具/投影 | `/plan` 命令适配器；**`exit_plan_mode` 的评审**走 `ctx.userQuestions`，TUI 需自己的提问实现 |
| jobs | seam + local 实现 + `dsh-tool-jobs`（含完成通知投递策略 wakeup/quiet） | 完成通知的「注入 vs 唤醒」依赖 inbox/followup——pi 的 inbox 若等价则可复用 |
| presets | 发现/挂载/认父/创作/代际逻辑 | 选择器 UI；创作面的 `openDocument` 需宿主桌面操作 |
| system prompt | 段/变量/工具 schema 组装 + `complete` 段 + waterfall | 无（纯组装，适配器把 schema 当 wire 字段） |
| session 投影/统计/缓存 | `dsh-session-projection` + `-stats` + `-cache` 全部逻辑 | 载体层（历史尾页块、`session/projection` 帧）是 apiproxy 的，TUI 需自建载体或复用 apiproxy |
| message feedback | 服务 + storage-domain 持久化 | `messageFeedback.*` Remote（TUI 可用同一 Typert client face） |
| 日志导出 | apiproxy 的 ZIP 流式端点实现 | `/export` 命令 + 浏览器下载 → TUI 写文件 |
| workspace | 注册表 + 持久化 | 无（服务级，UI 无关） |

### 传输/宿主层（TUI 可整体复用或绕过）
- **RPC/事件通道**：`dsh-host-apiproxy`（`RpcMethodMap` + `session/projection` 帧 + `/api` 协议）+ `dsh-client-connection`（双 WebSocket 下行 `events.mux`/`events.host`）。`dsh-api-remotes` README 明说：**「Web 或未来的 TUI 只要提供同一份不依赖 React 的 `ctx.remote` 约定，均可复用其 Client face」**——TUI 若走本地进程内调用，可直接复用 Typert Remote 层。
- **Web 服务器** `dsh-host-webserver`：纯载体，TUI 不需要。
- **shell-env**：`DSH_*` 变量收集，TUI 可保留（改成 `PI_*`）。
- **code-runtime-worker-thread**：Code Mode 执行器，TUI 可复用（依赖 `dsh-code-runtime` seam）。
- **invariants**：纯开发期自检注册表，移植时可整体保留（各包 `./invariant` 入口是独立的）。

### 移植时最值得照抄的五个「架构习惯」
1. **seam 分层**：抽象契约（seam）→ 可替换实现 → 面向模型工具 → 面向人类命令 → UI，五层各自独立包；换实现不换工具（workflow/subagent/jobs/fs 全是这个套路）。
2. **会话日志是唯一持久权威**，一切状态（goal/plan/todo/preset 选择）以「追加事件 + 折叠/投影」重建；缓存（projection cache）只是 fail-soft 捷径，绝不当权威。
3. **投影机制**：`init/apply/view` 纯同步、事件携带完整状态（last-wins）、`stateVersion` 作失效锚点——UI 数据流只订阅投影，不自己挂事件监听。
4. **模型权限与人类权限分离**：`{kind:'user'}` 来源是宿主证明（goal 工具、interrupt 授权、report 投递全依赖它）；subagent 继承不到父权限。
5. **进程本地状态不持久化**（goal activation、jobs 注册表、通知 reported 位），恢复后靠显式动作重新武装/重建，避免「自动复活」语义漂移。

---

## 附：关键文件路径索引（pnpm dlx 缓存内）
- 能力模块宿主澄清：`@deepseek-ai+dsh-client-modules@…/node_modules/@deepseek-ai/dsh-client-modules/lib/{index,client}.js`
- goal：`…/dsh-goal@…/lib/{index,typert.host,typert.remote-client}.js`；`…/dsh-tool-goal@…/lib/index.js`；`…/dsh-command-goal@…/lib/index.js`；`…/dsh-goal-round-driver@…/lib/index.js`；`…/dsh-client-ui-goal@…/lib/{index,client}.js`
- workflow：`…/dsh-workflow@…/lib/index.js`；`…/dsh-workflow-worker-thread@…/lib/{index,worker.cjs}`；`…/dsh-tool-workflow@…/lib/index.js`
- subagent：`…/dsh-subagent@…/lib/index.js`；`…/dsh-tool-subagent@…/lib/index.js`；`…/dsh-tool-subagent-control@…/lib/index.js`（+`/list-agents` 子路径）；`…/dsh-tool-subagent-report@…/lib/index.js`；`…/dsh-subagent-{spawn,fork}-in-process@…/lib/index.js`；`…/dsh-subagent-in-process-driver@…/lib/index.js`
- plan：`…/dsh-plan-mode@…/lib/index.js`；`…/dsh-client-ui-plan@…/lib/{index,client}.js`
- trajectory：`…/dsh-client-ui-trajectory@…/lib/{index,client}.js`（纯前端）
- jobs：`…/dsh-jobs@…/lib/index.js`；`…/dsh-jobs-local@…/lib/index.js`；`…/dsh-tool-jobs@…/lib/index.js`；`…/dsh-client-ui-jobs@…/lib/{index,client}.js`
- presets：`…/dsh-agent-presets@…/lib/index.js`（types 子目录：discovery/mount/session/authoring/metadata/preset）；bundled 数据 `…/@deepseek-ai+dsh@…/node_modules/@deepseek-ai/dsh/config/agent-presets/{standard,code,minimal,cordis}/{agent.cordis.yml,preset.yml}`；用户根 `~/.dsh/.agent-presets/`（当前空）
- system prompt：`…/dsh-system-prompt@…/lib/index.js`
- 会话级：`…/dsh-session-stats@…/lib/index.js`；`…/dsh-session-projection@…/lib/index.js`；`…/dsh-session-projection-cache@…/lib/index.js`；`…/dsh-message-feedback@…/lib/{index,typert.host,typert.remote-client}.js`；`…/dsh-session-log-export@…/lib/{index,client}.js`
- 宿主侧：`…/dsh-workspace@…/lib/index.js`；`…/dsh-host-apiproxy@…/lib/index.js`；`…/dsh-host-webserver@…/lib/index.js`；`…/dsh-shell-env@…/lib/index.js`；`…/dsh-client-connection@…/lib/{index,client}.js`；`…/dsh-api-remotes@…/lib/{index,client}.js`
- 其余：`…/dsh-code-runtime-worker-thread@…/lib/{index,worker.cjs}`；`…/dsh-invariants@…/lib/index.js`；`…/dsh-tool-todo@…/lib/index.js`；`…/dsh-tool-ask-user@…/lib/index.js`；`…/dsh-tool-ralph@…/lib/index.js`；`…/dsh-tool-web@…/lib/index.js`；`…/dsh-agent@…/lib/index.js`；`…/dsh-agent-loop@…/lib/index.js`
- 实际数据：`~/.dsh/sessions/<cwd-slug>/<sessionId>/session.jsonl.zstd`（首行为 `session` header，后随 `{type,seq,time,data}` 事件）；`~/.dsh/storages/{workspace.json,message_feedback.json,session_projcache.json}`（storage-domain 格式：`{unit:{name,version}, tables:{...}}`）
