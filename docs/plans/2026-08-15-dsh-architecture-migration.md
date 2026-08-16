# DSH 架构能力迁移到 pi coding agent — 调查与启动指南

> 状态：调查完成，范围已确认（提示词设计 + 部分工具能力，全部写 pi 扩展，A/B 对 `v0.1.0` tag）| 日期：2026-08-15
> 调查基线：DSH `@deepseek-ai/dsh-*@0.1.0-rc.6`（pnpm dlx 缓存，只读）+ `~/.dsh/` 运行时数据；pi `@earendil-works/pi-coding-agent@0.80.10`（node_modules + docs）+ `~/.pi/agent` 仓库现状。
> 配套文档（本目录下）：`2026-08-15-dsh-agent-capability-inventory.md`（DSH agent 能力层盘点）、`2026-08-15-pi-platform-capability-inventory.md`（pi 扩展平台能力边界）、`2026-08-15-dsh-plugin-architecture-inventory.md`（DSH Cordis 插件组装机制）。

## 0. TL;DR（三句话结论 + 第一步）

1. **两个工程本质不同**：DSH 是「配置驱动的 Cordis 插件容器」（`cordis.yml` 组装 + bundle patch 分层 + profile + HMR，agent 能力 = 事件溯源会话日志上的服务/工具/命令五件套）；pi 是「钩子驱动的扩展系统」（TS 模块自动发现 + 33 类事件 + `appendEntry` 写会话 JSONL），**事件模型与持久化载体天然同构**（DSH 会话 JSONL ⇄ pi 会话 JSONL）。
2. **迁移路径几乎全是「写 pi 扩展」**：已确认范围 = **提示词设计 + 部分工具能力**。DSH 的 system-prompt 组装机制（有序段注册表 + 严格变量插值 + complete 段 + KV-cache 纪律）在 pi 里**没有对应物**（pi 的 `prompts/` 是斜杠模板、`before_agent_start` 是单次整串替换、SYSTEM.md 是静态人格文件）——这是本次迁移的主战场；工具能力按第 7 节候选清单选。
3. **第一步建议：新建 `extensions/prompt-sections/`，把 DSH 的 system-prompt 组装机制移植成 pi 扩展**（section 注册表 → `before_agent_start` 链式装配 → 严格变量插值），并让现有各扩展的提示词注入（plan-mode / trident-routing / skill-kit trigger 表）改走 section 注册；用 `--flag`/settings 开关做 A/B，与 `v0.1.0` tag 对比（可量指标：usage 里的 input/cacheRead token、行为一致性）。

---

## 1. 两个工程各是什么

### 1.1 DSH（DeepSeek Harness, 0.1.0-rc.6）

- 形态：pnpm dlx 安装的命令行 `dsh` + Web GUI（本机 `http://127.0.0.1:3080`）。
- 架构三段式：
  - **`dsh-base` bundle**：共享核心（agent 循环、LLM 适配、会话/持久化、sandbox/权限、goal/subagent/workflow/jobs/plan 全套服务与工具、系统提示词组装）。`~/.dsh/profiles/web/package.json` → `bundles: [dsh-base, dsh-web-app]`。
  - **表层组合包**：`dsh-web-app`（浏览器表层：webserver、API 网关、workspace、浏览器插件名录、客户端 HMR）、`dsh-headless`（一次性任务）。
  - **profile 机制**（`~/.dsh/profiles/<name>/`）：`cordis.yml`（空根）+ `cordis.patch.yml`（用户 patch 层）+ package.json（bundle 清单）。CLI：`dsh --profile web|headless [args]`、`--patch` 叠加层、`--dump-config`。
- 关键组合文件（读这两个就能看懂 DSH 的整体装配）：
  - `@deepseek-ai/dsh-base/cordis.patch.yml`（~460 行：一行一个插件的核心树）
  - `@deepseek-ai/dsh-web-app/cordis.patch.yml`（浏览器表层行 + agent plane 移到 preset 的设计说明）
- 本机实际数据：`~/.dsh/sessions/<cwd-slug>/<sessionId>/session.jsonl.zstd`（事件溯源唯一权威）、`~/.dsh/storages/*.json`（storage-domain 持久化）、`~/.dsh/settings.yaml`（用户设置，热重载）。

### 1.2 pi coding agent（0.80.10）

- 形态：`pi` CLI（TUI）+ SDK（`createAgentSession`）+ RPC 模式；`~/.pi/agent` 是用户配置仓库（git），含 24+ 扩展目录、8 个单文件扩展、共享 `lib/` 工具库、skills、prompts。
- 扩展系统：`~/.pi/agent/extensions/*.ts` 或 `*/index.ts` 自动发现，jiti 加载零编译，`/reload` 热重载。注册面：`registerTool`（TypeBox schema，可覆盖内建工具）、`registerCommand`、`registerShortcut`、`registerFlag`、`registerProvider`、`pi.on(33 类事件)`、`pi.appendEntry`（CustomEntry 写会话 JSONL，不进 LLM 上下文）、`ctx.ui`（TUI 交互）、`sendUserMessage`（注入回合）。
- 会话：`~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`，JSONL + `type` 字段 + id/parentId 树结构（v3）——**与 DSH 会话日志同构**。

---

## 2. DSH 的「架构能力」盘点（按可迁移性分三层）

### 2.1 插件/组装架构（Cordis）—— 借鉴思想，不建议整套移植

> 完整机制见 `2026-08-15-dsh-plugin-architecture-inventory.md`（A–G 七节 + 4 个补充，含 patch 合并算法、profile/bundle/symlink 农场、HMR 事务重载、client-runtime 双入口等）。G 节给出「高移植价值 / 中等 / DSH 特有耦合」三档判定。

| DSH 机制 | 说明 | 对 pi 的判断 |
|---|---|---|
| `cordis.yml` 配置树 + Loader | 启动时组装插件行，服务可用性驱动激活 | pi 等价物：扩展自动发现 + settings.json `extensions[]/packages[]`。**不需要** |
| bundle patch 分层（last-write-wins、整行替换、`!!js` 表达式） | 一行一个插件、按 id 覆盖；离线 dump 与运行时同一算法 | **高移植价值**：这是「把可扩展应用做成可组合文档」的核心。pi 可借鉴为「settings.json 分层 + 扩展条件加载」，但不值得把 Cordis Loader 搬进来 |
| 服务可用性驱动的激活 + DI（`inject`/fiber/effect 清理） | 插件只声明依赖，不关心启动顺序 | **高移植价值的思想**：pi 扩展间协作可借鉴（当前扩展靠 `pi.events` 总线 + 加载顺序隐式耦合） |
| profile 机制（模板/bundles/`healProfilesModuleFallback`） | 多组装档位（web/headless/custom） | pi 没有多 profile；如果 pi 要支持「编码档/极简档」可以用 `--flag` + 扩展条件加载模拟。**低优先** |
| HMR（`cordis-plugin-hmr` + `dsh-client-hmr`） | 配置热更新 / 客户端 bundle 重载；事务性重载+回滚+last-good-tree | pi 已有 `/reload`（扩展热重载）。**不需要** |
| `isolate` realm / `intercept`（preset 服务隔离） | 单进程内多租户服务隔离与配置拦截 | **高移植价值的思想**：pi 多会话/多 agent 场景直接命中（当前 trident-subagent 用子进程隔离绕过） |
| fail-loud 启动审计（`assertEntriesActivated`） | 无 fiber/FAILED/PENDING 逐条归因 | **高移植价值**：成本低，pi 扩展加载失败目前静默降级 |
| 双面插件（node 半 + `exports["./client"]` 浏览器半 + `__DSH_BOOT__` 模块图） | 同一插件两端跑 | 这是 Web 宿主专属，pi 无浏览器内核。**不迁移**（除非走 pi-web 路线，见 4.4） |
| schemastery schema 驱动（配置校验+表单+dump 单一事实源） | 配置 schema 即文档 | pi 用 TypeBox（工具参数）已有等价物；配置面可借鉴「单一事实源」 |

**结论**：Cordis 整套（Loader/include/group/typert/浏览器移植版）是 DSH 特有耦合（`2026-08-15-dsh-plugin-architecture-inventory.md` G 节 DSH 特有耦合清单），**不整套移植**；但其中 4 个机制（分层 patch 组合、服务可用性激活、isolate 作用域、fail-loud 审计）作为「思想」值得在 pi 扩展架构里借鉴——如果「架构能力」指的是这一层，见第 5 节选型。

### 2.2 agent 运行时能力 —— 迁移重点（详见 `2026-08-15-dsh-agent-capability-inventory.md` 的 A 表与 B 节）

| 能力 | DSH 形态 | pi 现状 | 差距（= 要迁移的东西） |
|---|---|---|---|
| **goal** | 事件溯源状态机：`ctx.goals` 服务 + `get_goal/create_goal/update_goal` 工具 + `/goal` 命令 + `dsh-goal-round-driver` 续行（`agent/idle` 检查点） | `extensions/goal`：prompt 协议（`<summary>` XML）+ `agent_settled` 续行循环，**状态纯内存不落盘** | 持久化目标对象 + CAS + 状态机 + Round 预算 + subagent 执行拒绝 |
| **plan mode** | `plan/mode` 事件全量入日志 + `exit_plan_mode` 工具（须用户批准）+ order 50 策略段 + 投影 | `extensions/plan-mode`：工具集白名单 + `before_agent_start` 注入 + `[DONE:n]` 追踪 + appendEntry 持久化 | 状态机已基本等价；差「`exit_plan_mode` 工具 + 用户批准评审」与投影折叠 |
| **subagent** | seam（`ctx.subagents`）+ spawn/fork 提供方；子 agent = 独立 Session；continuable + `send_message/interrupt/list_agents/report`；深度预算持久化在 header | `trident-subagent`：spawn 隔离 `pi --mode json` 子进程 + 重试/调查包/状态 GUI；**无 fork 种子、无 continuable 冷恢复、深度只到进程** | fork（已完成轮次前缀）、continuable 持久描述符、`list_agents` 层级 |
| **workflow** | seam + worker-thread 引擎（`node:vm` 内跑模型写的 JS）+ `workflow` 工具 + `parallel/pipeline/agent/phase` 钩子 | **完全没有** | 引擎 + 工具 + 脚本协议（pi 的 subagent 是 `Promise.allSettled` 形态，无脚本编排） |
| **jobs** | 后台任务注册表 `ctx.jobs` + `job_output/job_list/job_kill` 工具 + 完成通知 | **pi 无内置后台任务**（无 `run_in_background`/`job_*` 原语，已核实 0.80.10 的 docs 与 dist 类型） | 完整迁移：统一注册表 + 工具 + 完成通知投递策略（wakeup/quiet） |
| **trajectory** | 纯前端时间线（数据 = 会话事件流 + sessionStats 投影） | 无；但 pi 有 `message_update`/`tool_execution_*` 事件流可自建 | 后端零改动（事件流现成），只需 TUI/Wails 渲染层 |
| **projection/统计** | 事件→读模型折叠（`session-projection` + `-stats` + `-cache`） | 无；`sessionManager.getEntries()` 可做等价折叠 | 折叠框架 + `session_projcache` 持久化 |
| **presets** | `agent.cordis.yml` 按 preset 组装 agent 的工具/提示词/投影 | 无（只有 `--plan` flag 级工具集切换） | preset 目录格式 + 会话 header 冻结 + 代际 |
| **message-feedback / workspace / 会话统计条** | storage-domain 持久化 + 服务 | 无 | 服务 + storage 抽象 |
| **system-prompt 组装** | 有序段 + 工具 schema + 变量 + `complete` 段 | pi 有 `before_agent_start` 链式替换 + `promptSnippet/promptGuidelines` | 基本等价，无需迁移 |

### 2.3 宿主/传输层 —— pi 对应物

| DSH | pi 对应 | 判断 |
|---|---|---|
| `dsh-host-apiproxy`（RPC/事件网关） | pi RPC 模式（`rpc.md` JSON 协议）+ `wails-gui` | pi 的 Web 路线已在 `docs/plans/pi-web-unified-plan.md` 规划；DSH 的 Typert Remote 可作参考 |
| `dsh-host-webserver` / `frontend-static` | Wails（`wails-gui/`） | 不迁移 |
| `dsh-shell-env`（`DSH_*` 变量） | 无 | 可抄（改成 `PI_*`） |
| `dsh-invariants`（包自检） | 无 | 可抄（轻量，开发期价值） |

---

## 3. pi 扩展平台边界（关键限制，决定迁移策略）

（详见 `2026-08-15-pi-platform-capability-inventory.md` A 节，这里只列影响选型的 6 条）

1. **无内置多 agent 编排原语**：subagent 只能扩展自己 spawn 子进程（当前 trident-subagent 即此形态）；DSH 的「子 agent = 独立 Session + continuable」语义需要自建持久描述符。
2. **agent 主循环不可改写**：自动重试/压缩/overflow 恢复只能观察不能改算法（钩子：`agent_settled`/`session_before_compact`/`tool_execution_*`）。
3. **会话控制方法仅限命令上下文**（`ctx.newSession/fork/switchSession` 不在工具 `execute()` 里）。
4. **UI 模式受限**：`ctx.ui.custom()` 仅 TUI；RPC 下走 `extension_ui_request/response` JSON 子协议。
5. **持久化只有两条官方通道**：`pi.appendEntry`（会话 JSONL CustomEntry）+ 扩展自己读写外部文件（如 `~/.pi/*.json`）。无独立 KV。
6. **无内置沙箱**：权限只能靠 `tool_call` 拦截模拟（现有 `permission-gate` 即此模式），做不到 DSH `dsh-fs-observation-policy`/sandbox 级别的强制。

结论：**写扩展路径覆盖所有迁移目标**；唯一要警惕的是 goal 续行与 subagent continuable 依赖的「idle 检查点」——pi 对应 `agent_settled`（C 报告确认：无重试/压缩/续行剩余时触发，语义与 DSH `agent/idle` 等价）。

---

## 4. 怎么开始（建议的启动路线）

> 已确认范围的执行路线分两条：**Track A = 提示词设计**（第 6 节，先做）、**Track B = 工具能力**（第 7 节，第一批 todo + str_replace_editor）。下面 4.2/4.3 是「若日后扩展到编排能力」的备选路线，供参考。

### 4.1 Track A/B 的公共前置

### 4.2 备选 spike（若后续扩展到编排能力）：DSH goal → pi 扩展

推荐理由：
- **价值**：pi 现有 `/goal` 是「无状态续行循环」，DSH 的 goal 是「持久化状态机」——升级后跨重启恢复、Round 预算、CAS 防陈旧引用都是真实收益。
- **边界**：5 个工具（`get_goal/create_goal/update_goal`）+ 1 命令（`/goal`）+ 1 钩子（`agent_settled`）+ 1 持久化通道（`appendEntry("dsh-goal", {…})` 或 `~/.pi/goal.json`）。
- **可验证**：不依赖任何 UI，TUI 即可验收。

spike 任务清单（建议在 `~/.pi/agent` 新建 `extensions/dsh-goal/`，参照现有 `extensions/goal/` 的形态）：
1. 目标对象 + 状态机（active/paused/completed/blocked + revision CAS）——直接翻译 DSH `dsh-goal` 领域逻辑（`2026-08-15-dsh-agent-capability-inventory.md` B1 节有完整状态机与 API 签名）。
2. 持久化：每变更 append 一条 CustomEntry（等价 `goal/change` 事件），恢复时折叠出当前目标——**事件溯源模式照抄**，载体换成 pi 会话 JSONL。
3. 工具注册：`get_goal/create_goal/update_goal`（TypeBox schema 照抄 DSH 参数）。
4. 命令：`/goal`（help/显示/编辑/pause/resume/clear）。
5. 续行驱动器：`pi.on("agent_settled")` → 检测 active+armed+Round 预算 → `sendUserMessage` 注入 `goal_round` 提示 → 模型用 `update_goal(complete)` 停轮。
6. 权限：`tool_call` 拦截——subagent 子进程（`PI_SUBAGENT=1`）内禁调 goal 工具（等价 DSH「subagent 执行一律被拒」）。
7. 验收：启动目标 → 连续续行 → complete → 新开 pi `/resume` 后目标还在但需显式 resume 重新武装。

### 4.3 阶段 1..N —— 后续能力迁移顺序（建议依赖序）

| 阶段 | 能力 | 复用 DSH 什么 | 适配 pi 什么 | 验证 |
|---|---|---|---|---|
| 1 | plan-mode 升级 | `plan/mode` 事件 + 投影折叠 + `exit_plan_mode` 审批流 | 现有 `plan-mode` 扩展加 `exit_plan_mode` 工具 + `ctx.ui.confirm` 评审 | `/plan` → 只读 → `exit_plan_mode` → 实施 |
| 2 | subagent 增强 | fork 种子（已完成轮次前缀）、continuable 描述符、`list_agents` 层级、深度预算 | `trident-subagent` 的 run 层加 fork/恢复；header 持久化改 `appendEntry` | 后台子 agent 跨重启 followup |
| 3 | workflow 引擎 | seam + worker-thread + `node:vm` 脚本协议 + `parallel/pipeline/agent/phase` | 复用 `lib/subagent-run.ts` 作 provider；`workflow` 工具注册 | 模型写脚本扇出 3 个 worker |
| 4 | jobs 统一注册表 | `ctx.jobs` + 完成通知 wakeup/quiet | 把 bash 后台作业/子 agent 后台形态统一进一个注册表 + `job_output/list/kill` | 后台任务可见、可取消 |
| 5 | 投影/轨迹 | `session-projection` 折叠框架 + `session-stats` | 用 `sessionManager.getEntries()` 折叠 + Wails/TUI 渲染 | 会话统计条/轨迹视图 |
| 6 | presets | `agent.cordis.yml` 组装 + 会话 header 冻结 | 扩展内实现 preset 目录解析 + 按 preset 过滤 `setActiveTools` + 注入提示词 | 编码档/极简档切换 |

### 4.4 可选路线：Web 表层

如果「架构能力」包含 Web 客户端架构（DSH 的 gateway/connection/ui-plugin 体系），走 `docs/plans/pi-web-unified-plan.md` 已规划的 Wails 路线，参考点不是 Cordis 双面插件，而是：`dsh-host-apiproxy` 的 `RpcMethodMap` + 事件帧协议、`dsh-client-modules` 的惰性模块图思想、`session-projection` 帧（UI 只订阅投影不挂事件）。这条线是独立大工程，建议排在 4.3 的 1-6 之后。

---

## 5. 已确认的选型

**用户拍板（2026-08-15）**：
1. 范围：**提示词设计 + 部分工具能力**（非整套 Cordis 组装架构、非 Web 客户端架构）。
2. 载体：**全部写 pi 扩展**。
3. 测试策略：仓库已有 `v0.1.0` tag（另有 `base` tag），新实现做成**可开关**（`--flag` 或 settings.json），与 v0.1.0 行为 A/B 对比。
4. 工具清单（第 7 节）：**todo_write、str_replace_editor、goal 工具组、jobs 工具组**（已确认；ralph、ask_user/web_search 规范化不选）。

---

## 6. 聚焦迁移目标 A：提示词设计（DSH system-prompt 组装 → pi 扩展）

### 6.1 DSH 的机制（已核实 `dsh-system-prompt` 类型定义）

- **有序段注册表**：`PromptSection {name, order, text|fn, complete?}`，按 order 升序拼接；命名约定：`-100` = harness 身份、`0` = persona（`PERSONA_SECTION="deployment:persona"`）、`100–199` = 工具指导段。
- **严格 `{{variable}}` 插值**：`variable(name, provider)` 每轮装配求值；`renderPrompt` 对未知/未定义引用**抛错**，空段丢弃，按空行拼接。
- **complete 段**：注册 `complete:true` 的段装配后成为唯一提示词（可整体取代，如 minimal preset 的 persona）；多个有效 complete 段 → 装配失败。
- **动态 context 快照**：`context(name, order, text)` 渲染成 user-role 持久快照（如 runtime 上下文），与提示词正文分离。
- **工具 schema 提供方 + 排序**：`tools(provider)` 贡献工具目录；`toolOrder` 配置显式排序（`TOOL_ORDER_REST` 标记未列出工具）。
- **scope 分层遮蔽**：agent → preset → global 同名校名遮蔽（近者胜）。
- **KV-cache 纪律**：稳定段（身份/persona/策略）放头部，按请求变化的内容（cwd/模型名）放其后或尾部——跨轮次请求前缀稳定，不击穿缓存。
- 装配瀑布：`system-prompt/assemble` 事件链，返回值权威；`system-prompt/change` 通知注册表变更。

### 6.2 pi 现状与差距

| pi 现状 | 差距（= 要迁移的） |
|---|---|
| `SYSTEM.md`：静态人格文件，整份进系统提示词 | 无分段/排序/变量机制；persona 无法按 agent/会话遮蔽 |
| `before_agent_start` 事件：可链式替换 systemPrompt（现有 plan-mode、trident-routing 母港、skill-kit trigger 表都在这里拼字符串） | 各扩展各自拼串、顺序隐式、无统一注册表 → 迁移目标：**统一收口到 section 注册表** |
| 工具 `promptSnippet` + `promptGuidelines`（进 "Available tools" 节） | 无工具级排序/隐藏（DSH 的 `toolOrder`/presentation mode） |
| `prompts/*.md` 斜杠模板（`/name` 展开） | 这是用户主动调用的模板，**不是**系统提示词组装——保留不动 |
| usage 统计（`SubagentUsage.cacheRead/cacheWrite`，lib/subagent-run 已有） | A/B 的量化通道已就绪（input/cacheRead token 对比） |

### 6.3 迁移方案（spike：`extensions/prompt-sections/`）

1. **section 注册表**（纯 TS，不依赖 cordis）：`registerSection({name, order, text|fn, complete?})` + `registerVariable(name, provider)` + `assemble(ctx) → {sections, variables}` + `renderPrompt()`（严格插值、空段丢弃、空行拼接——逐条照抄 DSH 语义）。
2. **装配入口**：`pi.on("before_agent_start", ...)` 里 `assemble()` → 返回 `{systemPrompt: rendered}`（pi 事件链后注册者可见前置结果，注意测试链式顺序）；现有扩展的字符串注入（plan-mode 的 `[PLAN MODE ACTIVE]`、trident-routing 的母港 systemPrompt、skill-kit 的 trigger 表）**逐个改注册为 section**（order：-100 身份 / 0 persona / 50 策略 / 100-199 工具指导）。
3. **SYSTEM.md 人格** 变 order-0 persona 段（可被 `--persona <file>` 或会话级覆盖遮蔽，等价 DSH `dsh-persona` 的 scope 遮蔽）。
4. **变量**：`{{model}}`/`{{cwd}}`/`{{date}}` 等注册为 provider；动态内容（cwd、工作区）放稳定段之后，保 KV-cache。
5. **工具指导**：把各工具 `promptSnippet/promptGuidelines` 收集进工具指导段（可选：按 DSH `toolOrder` 思路做排序）。
6. **开关与 A/B**：settings.json `promptSections: true|false`（或 `--prompt-sections` flag）——开 = 新装配，关 = 走回 v0.1.0 的 SYSTEM.md + 各扩展原生注入；对比指标：usage input/cacheRead token、行为一致性、用户主观质量。
7. **验收**：`/sysprompt`（已有扩展）导出新旧两版系统提示词 diff；`session_start` 注入版本号便于回溯。

---

## 7. 聚焦迁移目标 B：部分工具能力（已确认 4 项）

> 基于能力盘点（`2026-08-15-dsh-agent-capability-inventory.md` A 表）与 pi 现状（`2026-08-15-pi-platform-capability-inventory.md` C 表），pi 内建工具只有 `read/bash/edit/write/find/grep/ls`，todo/web/ask-user 均来自扩展。

### 已确认清单（按执行顺序）

| # | 能力 | DSH 工具 / 服务 | pi 现状 | 迁移要点（对照 `dsh-agent-capability-inventory.md`） | 工作量 | 状态 |
|---|---|---|---|---|---|---|
| 1 | **todo 任务列表** | `dsh-tool-todo`：`todo_write(todos)` 全量快照 last-wins，`todo/write` 事件入日志 | **无内建 todo 工具**（plan-mode 扩展有 `[DONE:n]` 追踪但非独立工具） | 全量替换 + 快照事件（折叠恢复）；TypeBox schema 照抄 | 小 | ✅ `extensions/dsh-tools/todo.ts` |
| 2 | **str_replace_editor** | `dsh-tool-str-replace-editor`：`old_string→new_string` 精确替换，maxOutputChars 16000 | pi `edit` 是行号/正则 diff 风格（edit-diff） | 语义照抄；注意与 pi `edit` 共存时的工具选择引导 | 小 | ✅ `extensions/dsh-tools/str-replace.ts` |
| 3 | **goal 工具组** | `dsh-goal` 服务 + `dsh-tool-goal`：`get_goal/create_goal/update_goal`（事件溯源 + revision CAS + Round 预算 + subagent 执行拒绝） | 现有 `/goal` 扩展是纯内存续行循环（prompt 协议） | 状态机/CAS/Round 逻辑照抄 B1 节；持久化用 `appendEntry`（等价 `goal/change` 事件）；续行驱动器挂 `agent_settled`；与现有 `/goal` 扩展 A/B 对比 | 中 | ✅ `extensions/dsh-goal/`（2026-08-15） |
| 4 | **jobs 工具组** | `dsh-jobs` + `dsh-jobs-local` + `dsh-tool-jobs`：`job_output/job_list/job_kill` + 完成通知（wakeup/quiet） | **无**（pi 无后台任务原语） | 先建统一后台任务注册表（内存，重启即失——照抄 DSH「进程本地状态不持久化」）；bash 后台/子 agent 后台形态统一接入；完成通知经 `ctx.ui.notify` + `sendUserMessage` 投递 | 中 | ⏳ 第三批 |

**不选**：ralph（基于 subagent 的包装，价值低-中）、ask_user/web_search 规范化（已有扩展基本等价）。

### 执行顺序建议

1. **第一批**（#1 #2，✅ 已完成 2026-08-15）：`extensions/dsh-tools/`——`todo_write`（appendEntry 持久化 + `/dsh-todos` 折叠展示）+ `str_replace_editor`（view/create/str_replace/insert 四命令，行号编辑工作流；与 pi `edit` 的唯一性要求等价，差异化在行号定位）。开关：settings `dshTodo` / `dshTodoParallel` / `dshStrReplaceEditor`。
2. **第二批**（#3，✅ 已完成 2026-08-15）：`extensions/dsh-goal/`——事件溯源状态机（state.ts）+ 三工具与人类权限（tools.ts）+ `agent_settled` 续行驱动器（driver.ts）+ `appendEntry("dsh-goal-change")` 持久化与 `session_start` 折叠恢复。开关 `dshGoal`（默认 false，与现有 `/goal` 扩展 A/B 共存）。27 项单测全过。
3. **第三批**（#4）：jobs 工具组——先建注册表（可复用在 trident-subagent 的后台形态上），再挂工具。

---

## 附：关键路径索引

- DSH 组合文件：`~/.dsh/profiles/web/{cordis.yml,cordis.patch.yml,package.json}`；缓存内 `@deepseek-ai/dsh-base/cordis.patch.yml`、`@deepseek-ai/dsh-web-app/cordis.patch.yml`
- DSH 启动：`@deepseek-ai/dsh-app-boot/README.zh.md`（boot/profile/patch 全机制）
- DSH 插件机制全貌：`2026-08-15-dsh-plugin-architecture-inventory.md`（A–G + 补充 1-4，含 patch 合并算法 / profile-symlink 农场 / HMR 事务重载 / client-runtime 双入口）
- DSH 能力（逐包）：`2026-08-15-dsh-agent-capability-inventory.md` 文末路径索引
- pi 扩展 API：`node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`（2911 行）、`dist/core/extensions/types.d.ts`；pi 平台边界与已有实现：`2026-08-15-pi-platform-capability-inventory.md`
- pi 会话格式：`docs/session-format.md`；pi SDK：`docs/sdk.md`；pi 开发（改本体）：`docs/development.md`
- pi 仓库现状：`~/.pi/agent/extensions/`（24 目录 + 8 单文件）、`~/.pi/agent/lib/`（共享工具库）
