> 版本基准：@earendil-works/pi-coding-agent@0.80.10

# pi 扩展平台能力边界 + 已有实现清单

> 版本基准：`@earendil-works/pi-coding-agent@0.80.10`（node_modules 内 dist 编译产物 + docs），用户配置仓库 `/home/clyzhi/.pi/agent`（以下简称 `~/.pi/agent`）。
> 方法：通读 `docs/extensions.md`(2911 行)/`sdk.md`/`rpc.md`/`sessions.md`/`skills.md`/`settings.md`/`development.md`/`security.md`，`dist/core/extensions/types.d.ts`(1245 行)/`runner.d.ts` 精确签名，以及 `extensions/` 下全部 24 个目录 + 8 个单文件扩展与 `lib/` 辅助库。

---

## A. pi 扩展平台能力边界

### A.1 扩展能注册什么

| 注册面 | API | 说明 |
|---|---|---|
| **工具** | `pi.registerTool(def)` | LLM 可调用；TypeBox 参数 schema；可覆盖内建工具（read/bash/edit/write/grep/find/ls）；支持 `executionMode`、`prepareArguments`、`promptSnippet`/`promptGuidelines` 注入系统提示词、`renderCall`/`renderResult` 自定义 TUI 渲染、`terminate: true` 提前结束回合；运行时可用 `pi.setActiveTools()` 做动态工具加载（Anthropic/OpenAI 原生 deferred-loading） |
| **命令** | `pi.registerCommand(name, {handler, getArgumentCompletions})` | 斜杠命令 `/xxx`；同名自动加 `:1`/`:2` 后缀；handler 拿 `ExtensionCommandContext`（比事件上下文多会话控制方法） |
| **快捷键** | `pi.registerShortcut(KeyId, {handler})` | 如 `ctrl+o`、`ctrl+shift+t`、`ctrl+alt+p` |
| **CLI flag** | `pi.registerFlag(name, {type:"boolean"\|"string", default})` / `pi.getFlag()` | 如 `--plan` |
| **Provider** | `pi.registerProvider(name, config)` / `pi.unregisterProvider` | 动态注册/覆盖模型供应商：`baseUrl`/`apiKey`/`api`/`models`/`headers`/`refreshModels` 在线拉取/`oauth` 登录流/`streamSimple` 自定义流式解析；加载期调用排队、运行期立即生效 |
| **事件** | `pi.on(event, handler)` | 33 类事件（见 A.2）；多数可返回结果对象（block/cancel/transform/替换 payload 等） |
| **渲染器** | `pi.registerMessageRenderer(type)` / `pi.registerEntryRenderer(type)` | 自定义 TUI 渲染（message 进 LLM 上下文；entry 不进） |
| **UI 交互** | `ctx.ui` | `select/confirm/input/editor/notify`（可带 timeout/AbortSignal）、`custom()` 全屏自定义组件（可 overlay）、`setStatus/setWidget/setFooter/setHeader/setTitle/setEditorText/pasteToEditor/addAutocompleteProvider/setEditorComponent`（替换为 vim 式编辑器）、`setWorkingMessage/setWorkingIndicator`、主题管理 `getAllThemes/setTheme` |
| **持久化** | `pi.appendEntry(customType, data)` | 以 CustomEntry 写入会话 JSONL，**不进入 LLM 上下文**；跨重启从 `ctx.sessionManager.getEntries()` 恢复（分支感知） |
| **消息注入** | `pi.sendMessage()`（进上下文）/ `pi.sendUserMessage()`（模拟用户输入，必触发回合；`deliverAs: "steer"|"followUp"|"nextTurn"`） | 扩展→LLM 的唯一正规通道 |
| **会话控制**（仅命令上下文） | `ctx.newSession/fork/navigateTree/switchSession/reload/waitForIdle` | 工具/事件上下文没有，防止死锁 |
| **资源贡献** | `resources_discover` 事件返回 `skillPaths/promptPaths/themePaths` | 扩展可动态追加技能/提示词/主题 |
| **信任决策** | `project_trust` 事件返回 `{trusted:"yes"|"no"|"undecided", remember}` | 仅全局/用户级扩展与 CLI `-e` 扩展参与 |
| **进程/网络** | `pi.exec(cmd, args)`、node 全量内置（`child_process`/`fs`/`fetch` 等） | 扩展与宿主同权限 |

### A.2 事件体系清单（33 类，`types.d.ts` 的 `ExtensionEvent` 并集）

- **生命周期/信任**：`project_trust`、`resources_discover`
- **会话**：`session_start`、`session_info_changed`、`session_before_switch`(可 cancel)、`session_before_fork`(可 cancel)、`session_before_compact`(可 cancel/自定义摘要)、`session_compact`、`session_before_tree`(可 cancel/自定义摘要)、`session_tree`、`session_shutdown`
- **Agent**：`before_agent_start`(注入 message + 链式替换 systemPrompt)、`agent_start`、`agent_end`、`agent_settled`（无重试/压缩/续行剩余时触发，状态集成用）
- **回合/消息**：`turn_start`、`turn_end`、`message_start`、`message_update`(token 流)、`message_end`(可替换消息)
- **工具执行**：`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`tool_call`(可 block、可原地改参数)、`tool_result`(可改结果，middleware 链式)
- **模型**：`model_select`、`thinking_level_select`
- **上下文/Provider**：`context`(可过滤/改写消息)、`before_provider_headers`(原地改 header)、`before_provider_request`(可替换 payload)、`after_provider_response`
- **用户侧**：`user_bash`(`!`/`!!` 可拦截/替换执行后端)、`input`(可 transform/handled/continue)

**关键执行语义**：tool_call 的 `event.input` 可变（后置 handler 可见前置修改，改后不再校验）；tool_result 结果按加载顺序链式合并（`content`/`details`/`isError` 可部分 patch）；input 事件 transform 链式、`handled` 短路；`ctx.signal` 提供 AbortSignal 供扩展侧 fetch/子进程协作取消。

### A.3 生命周期

```
factory 执行（jiti 加载 TS，无需编译；async factory 会阻塞启动）→ 绑定
project_trust → session_start{reason} → resources_discover
回合循环：input → before_agent_start → agent_start → turn_start → context →
  before_provider_headers/request → after_provider_response → LLM →
  tool_execution_start → tool_call → tool_execution_update → tool_result → tool_execution_end
  → turn_end → agent_end → agent_settled
/new /resume /fork：session_before_switch/fork(可 cancel) → session_shutdown →
  重载并重绑扩展 → session_start{reason, previousSessionFile}
/reload：session_shutdown{reason:"reload"} → 重载资源 → session_start{reason:"reload"}
退出：session_shutdown{reason:"quit"}
```

加载位置：`~/.pi/agent/extensions/*.ts` 与 `*/index.ts`（全局）、`.pi/extensions/`（项目，需先信任）、`settings.json` 的 `extensions[]`/`packages[]`、CLI `-e`。热重载 `/reload` 支持。安全模型：**无内置沙箱**（security.md 明示），扩展与 pi 同权限，隔离只能靠 OS/容器（官方建议 Gondolin 微 VM 路由工具执行）。

### A.4 限制：扩展做不了什么（必须改本体）

1. **无多 agent 编排原语**：pi 没有内置 subagent/task 队列/worker 池 API —— 仓库里所有 subagent 能力都是扩展自己 `spawn` 隔离的 `pi --mode json -p` 子进程拼出来的（见 D 节）。
2. **agent 主循环不可改写**：自动重试、自动压缩触发、overflow 恢复、工具并行调度等只暴露观察/钩子事件（`agent_start/agent_end/agent_settled`、`session_before_compact`、`tool_execution_*`），不能改算法本身；重试策略只能改 `settings.json` 的 `retry.{enabled,maxRetries,baseDelayMs}`。
3. **会话控制方法仅限命令上下文**：工具 `execute()` 拿到的是 `ExtensionContext`，没有 `newSession/fork/switchSession/reload`；扩展要 reload 必须注册命令再让工具 `sendUserMessage("/reload-runtime", {deliverAs:"followUp"})` 排队（官方模式）。
4. **UI 模式受限**：`ctx.ui.custom()` 仅 TUI 有效（RPC 下返回 undefined）；print/json 模式 `ctx.hasUI=false`、UI 方法 no-op；RPC 模式对话框走 `extension_ui_request/extension_ui_response` JSON 子协议（见 rpc.md）。
5. **持久化无独立 KV**：唯一官方持久化通道是会话 JSONL 的 CustomEntry（`appendEntry`）+ 外部文件（扩展自己读写）；自定义 entry 不进 LLM 上下文，进上下文的只能是 `sendMessage`。
6. **Provider 传输层只可钩不可换**：请求头/请求体/响应头有钩子，但 HTTP 客户端、SSE 解析、认证存储（auth.json）等不开放（除非用 `streamSimple`/`oauth` 白名单能力）。
7. **不可以在 factory 里起长驻资源**（文档明令：进程/socket/文件监听/定时器必须推迟到 `session_start` 或使用处，并在 `session_shutdown` 清理）。
8. **无法新增内建工具/新事件类型/改会话文件格式**——这些在 `dist/core/` 编译产物里，只能改本体（见 E 节）。

---

## B. ExtensionAPI 关键接口签名摘录

（出处：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`）

```ts
// 工具定义
interface ToolDefinition<TParams extends TSchema, TDetails = unknown, TState = any> {
  name: string; label: string; description: string;
  promptSnippet?: string;                  // "Available tools" 一节的一行简介
  promptGuidelines?: string[];             // 追加到默认 Guidelines，激活时生效
  parameters: TParams;                     // TypeBox schema
  renderShell?: "default" | "self";
  prepareArguments?: (args: unknown) => Static<TParams>;  // 兼容旧会话参数
  executionMode?: ToolExecutionMode;       // "sequential" | "parallel"
  execute(toolCallId: string, params: Static<TParams>,
          signal: AbortSignal | undefined,
          onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
          ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>;
  renderCall?: (args, theme, context: ToolRenderContext) => Component;
  renderResult?: (result, options: ToolRenderResultOptions, theme, context) => Component;
}

// ExtensionAPI（pi 对象）
interface ExtensionAPI {
  on(event, handler): void;                // 33 类事件，见 A.2
  registerTool<TParams,TDetails,TState>(tool: ToolDefinition<...>): void;
  registerCommand(name: string, options: Omit<RegisteredCommand, "name"|"sourceInfo">): void;
  registerShortcut(shortcut: KeyId, options: { description?; handler(ctx): void|Promise<void> }): void;
  registerFlag(name, options: { type: "boolean"|"string"; default? }): void;
  getFlag(name): boolean | string | undefined;
  registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void;
  registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void;
  sendMessage<T>(message: Pick<CustomMessage<T>, "customType"|"content"|"display"|"details">,
                 options?: { triggerTurn?; deliverAs?: "steer"|"followUp"|"nextTurn" }): void;
  sendUserMessage(content: string | (TextContent|ImageContent)[],
                  options?: { deliverAs?: "steer"|"followUp" }): void;
  appendEntry<T>(customType: string, data?: T): void;   // 持久化（不进 LLM 上下文）
  setSessionName(name: string): void;  getSessionName(): string | undefined;
  setLabel(entryId: string, label: string | undefined): void;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  getActiveTools(): string[];  getAllTools(): ToolInfo[];  setActiveTools(names: string[]): void;
  getCommands(): SlashCommandInfo[];
  setModel(model): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;  setThinkingLevel(level): void;
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
  events: EventBus;                    // 扩展间通信总线（emit/on）
}

// ExtensionContext（所有 handler 的 ctx）
interface ExtensionContext {
  ui: ExtensionUIContext;  mode: "tui"|"rpc"|"json"|"print";  hasUI: boolean;  cwd: string;
  sessionManager: ReadonlySessionManager;   // getEntries/getBranch/buildContextEntries/getLeafId/getLabel
  modelRegistry: ModelRegistry;  model: Model | undefined;
  isIdle(): boolean;  isProjectTrusted(): boolean;
  signal: AbortSignal | undefined;          // 活跃回合才有
  abort(): void;  hasPendingMessages(): boolean;
  shutdown(): void;                         // 优雅退出（等 idle）
  getContextUsage(): ContextUsage | undefined;
  compact(options?: { customInstructions?; onComplete?; onError? }): void;
  getSystemPrompt(): string;
}
interface ExtensionCommandContext extends ExtensionContext {
  getSystemPromptOptions(): BuildSystemPromptOptions;
  waitForIdle(): Promise<void>;
  newSession(options?: { parentSession?; setup?(sm): Promise<void>;
                         withSession?(ctx: ReplacedSessionContext): Promise<void> }): Promise<{cancelled}>;
  fork(entryId, options?: { position?: "before"|"at"; withSession? }): Promise<{cancelled}>;
  navigateTree(targetId, options?: { summarize?; customInstructions?; replaceInstructions?; label? }): Promise<{cancelled}>;
  switchSession(sessionPath, options?: { withSession? }): Promise<{cancelled}>;
  reload(): Promise<void>;
}

// ExtensionUIContext（关键方法）
interface ExtensionUIContext {
  select(title, options: string[], opts?: {signal?; timeout?}): Promise<string|undefined>;
  confirm(title, message, opts?): Promise<boolean>;
  input(title, placeholder?, opts?): Promise<string|undefined>;
  editor(title, prefill?): Promise<string|undefined>;
  notify(message, type?: "info"|"warning"|"error"): void;
  custom<T>(factory: (tui, theme, keybindings, done) => Component | Promise<Component>,
            options?: { overlay?; overlayOptions?; onHandle? }): Promise<T>;
  setStatus(key, text|undefined): void;  setWidget(key, lines|factory|undefined, {placement?}): void;
  setFooter(factory|undefined): void;    setHeader(factory|undefined): void;  setTitle(t): void;
  setEditorText(t): void;  getEditorText(): string;  pasteToEditor(t): void;
  addAutocompleteProvider(factory): void;
  setEditorComponent(factory|undefined): void;  getEditorComponent(): EditorFactory|undefined;
  setWorkingMessage(m?): void;  setWorkingVisible(v): void;  setWorkingIndicator(o?): void;
  setHiddenThinkingLabel(label?): void;  onTerminalInput(h): () => void;
  theme: Theme;  getAllThemes();  getTheme(name);  setTheme(name|Theme): {success,error?};
  getToolsExpanded(): boolean;  setToolsExpanded(v): void;
}

// 事件结果类型（handler 返回值）
ToolCallEventResult = { block?: boolean; reason?: string }           // tool_call
ToolResultEventResult = { content?; details?; isError? }             // tool_result（链式 patch）
InputEventResult = { action: "continue" } | { action: "transform", text, images? } | { action: "handled" }
BeforeAgentStartEventResult = { message?: Pick<CustomMessage,...>; systemPrompt?: string }
SessionBeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult }
SessionBeforeSwitchResult / SessionBeforeForkResult = { cancel?: boolean }
UserBashEventResult = { operations?: BashOperations } | { result?: BashResult }
ProjectTrustEventResult = { trusted: "yes"|"no"|"undecided"; remember?: boolean }
MessageEndEventResult = { message?: AgentMessage }                    // 同 role 替换
ResourcesDiscoverResult = { skillPaths?; promptPaths?; themePaths? }
```

运行器：`ExtensionRunner`（`dist/core/extensions/runner.d.ts`）负责 `emit/emitToolCall/emitToolResult/emitInput/emitBeforeAgentStart/emitResourcesDiscover/emitProjectTrust` 等分发，`bindCore(actions, contextActions, providerActions)` 注入 pi.* 方法实现，`createContext()/createCommandContext()` 按需解析上下文（值实时解析）。

---

## C. 已有实现清单（~/.pi/agent）

> 无独立 `extensions/subagent` 与 `extensions/session-search` 目录：subagent 能力 = trident-subagent + `lib/subagent-*.ts`；session 内容搜索已并入 session-browse（源码注明"从 session-search 合并"）。另 `lib/` 是仓库内共享工具库（非扩展，扩展经 `../../lib/...` 引用）。

| 扩展 | 文件 | 注册面（工具/命令/事件） | 状态持久化 |
|---|---|---|---|
| **trident-subagent** | `extensions/trident-subagent/{index,batch,feedback,status}.ts` | 工具 `subagent`（单/并行 worker）；命令 `/subagent:feedback` `/gui:subagents` `/trident-models` `/gui:trident-setup` | 内存 worker 快照 → `~/.pi/subagent-status.json`（GUI 轮询）；反馈开关 `~/.pi/subagent-feedback.json`；模型路由 `providers.roles.toml` |
| **goal** | `extensions/goal/index.ts` | 命令 `/goal`；事件 `agent_settled`(循环核心) `input`(用户打断重置) `message_end`(抑制完成通知) `session_shutdown` | 纯内存（靠会话里的 `<summary>` XML 消息 + 300ms 定时器续行）；无跨重启恢复 |
| **plan-mode** | `extensions/plan-mode/{index,utils}.ts` | 命令 `/plan` `/todos`；flag `--plan`；快捷键 ctrl+alt+p；事件 `tool_call`(bash 白名单拦截) `context`(过滤过期 plan 消息) `before_agent_start`(注入 [PLAN MODE ACTIVE]/[EXECUTING PLAN]) `turn_end`(`[DONE:n]` 追踪) `agent_end`(提取待办+用户选择) `session_start`(恢复) | `pi.appendEntry("plan-mode", {enabled,todos,executing})` 写入会话 JSONL；恢复时重扫消息重建完成状态 |
| **subagent-supplement-bridge** | `extensions/subagent-supplement-bridge/index.ts` | 事件 `tool_execution_end`（worker 子进程内由 env `PI_SUBAGENT_INBOX` 激活：claim 队列 → `sendUserMessage(⟦pi-supplement:v1⟧+JSON, {deliverAs:"steer"})`） | 队列 `~/.pi/subagent-supplements/<inboxId>.json`（lib 层实现，锁目录+原子 rename） |
| **permission-gate** | `extensions/permission-gate/{index,rule-engine,scanner,inline-script}.ts` | 事件 `tool_call`(bash 分级审核：白名单→autoReject→Wails GUI 审批→TUI 兜底) `tool_result`(动态放行插备注) `session_start`(pnpm 检测) | 用户审批理由 `~/.pi/agent/permission-gate-reasons.json`（20 条）；动态放行集合仅内存 |
| **plan-mode 相关** | 见上 | | |
| **session-browse**（含 session-search） | `extensions/session-browse/index.ts` | 命令 `/sessions` `/find-session`（跨 workdir 列/筛/搜 session，可 `ctx.switchSession` 恢复）；`SessionManager.listAll()` 全量扫描 | 无（读 session 文件） |
| **task-notification** | `extensions/task-notification/index.ts` | 事件 `agent_start`(取消延迟) `agent_end`(完成/aborted/可重试网络错误分级处理) `session_shutdown`；命令 `/notify-sound-test` | 无（3s 延迟通知定时器，进程内） |
| **skill-kit** | `extensions/skill-kit/index.ts` | 命令 `/skill-manager`；事件 `session_start`(git clone+软链接同步技能仓库) `session_shutdown` `before_agent_start`(占位符/日期/pi-self 处理 + 技能预检注入 trigger 表) | `skill-states.json`(禁用列表)；`skill-repo/repo.toml`(仓库清单)；skills/ 软链接 |
| **tool-checker** | `extensions/tool-checker/{index,types}.ts` | 命令 `/show-status`；事件 `session_start`(声明式检测 tools.toml 中的外部 CLI) `session_shutdown` `before_agent_start`(注入检测结果/提示) | tools.toml 声明；检测结果进程内缓存 |
| **ask-question** | `extensions/ask-question/index.ts` | 工具 `ask_question`（结构化多问题 TUI 表单，tab 页签+自定义输入，renderCall/renderResult 自定义渲染） | 无（答案随 tool result details 进会话） |
| **confirm-destructive** | `extensions/confirm-destructive.ts` | 事件 `session_before_switch`(新会话/恢复确认) `session_before_fork`(分叉确认) | 无 |
| **protected-paths** | `extensions/protected-paths.ts` | 事件 `tool_call`(拦截 write/edit 到 .env/.git/node_modules) | 无 |
| **thinking-control** | `extensions/thinking-control.ts` | 命令 `/change-think-effort`（探测模型不支持的 thinking 档位后选择） | 无 |
| **stream-monitor** | `extensions/stream-monitor/index.ts` | 命令 `/token-stream-stats`；事件 `message_update`(tok/s 测速) `message_end` `tool_execution_start/update/end`(工具耗时) `agent_end` `session_start/shutdown` | 无（内存统计，MAX_STATS=5 条响应） |
| **custom-providers** | `extensions/custom-providers/{index,loader,detector,models,models-dev,provider-diff,fast-add,types}.ts` | 命令 `/provider:fast-add` `/provider:reload` `/provider:reload-online`；事件 `model_select` `session_start`；`pi.registerProvider()` 批量注册 providers.toml 模型 | `~/.pi/agent/providers.toml`（TOML 配置 + 在线刷新回写）；`models-store.json`；auth.json 读 key |
| **sysinfo** | `extensions/sysinfo/index.ts` | 命令 `/sysinfo`（收集系统信息 → `sendUserMessage` 注入） | 无 |
| **deepseek-search** | `extensions/deepseek-search/index.ts` | 工具 `web_search_agent`（DeepSeek Responses API 服务端 web_search 代理搜索） | 读 `auth.json` 的 `deepseek.key` |
| **trident-routing** | `extensions/trident-routing/{index,todo-scan}.ts` | 命令 `/homeport`(母港维修模式: 替换系统提示词) `/gui:scan-todo`；快捷键 ctrl+shift+t；事件 `session_start`(开场白 appendEntry + 工具集校准) `before_agent_start`(母港替换 systemPrompt)；`registerEntryRenderer("trident-greeting")` | `pi.appendEntry("trident-greeting")` 会话内 |
| **tool-param-normalizer** | `extensions/tool-param-normalizer/index.ts` | 事件 `tool_call`(edit 参数别名归一化 old_str→oldText) `tool_result`(错误落盘日志) | `~/.pi/agent/tool-errors.log` |
| **be-error-recorder** | `extensions/be-error-recorder/index.ts` | 事件 `tool_result`(仅反馈模式 worker 显式加载；be-* 失败追加记录) | `~/.pi/subagent-be-errors.jsonl` |
| **settings-sync** | `extensions/settings-sync.ts` | 事件 `session_start`(tracked→settings.json 单向同步) `session_shutdown`(兜底回写)；`fs.watch` 实时防抖回写 | `settings.tracked.json`(git 跟踪真相源) ⇄ `settings.json`(gitignore)；黑名单字段不参与 |
| **ctrl-c-safety** | `extensions/ctrl-c-safety.ts` | 快捷键 `ctrl+c`（保存编辑器内容到历史后清空） | `~/.pi/agent/queue/cliphist.json`(15 条) |
| **editor-gui** | `extensions/editor-gui/index.ts` | 命令 `/prompt-edit-gui`（Wails GUI 编辑提示词/Ctrl+C 历史） | 读 cliphist.json |
| **external-editor-shortcuts** | `extensions/external-editor-shortcuts.ts` | 快捷键 `ctrl+o`；命令 `/open-editor`（外部编辑器打开 cwd/文件） | 读 settings.json `editor` |
| **copy-code-block** | `extensions/copy-code-block/index.ts` | 命令 `/copy-code-block`（从会话提取代码块复制剪贴板） | 无 |
| **talk-sleep** | `extensions/talk-sleep/index.ts` | 命令 `/talk-sleep` `/talk-sleep-load`（暂存/恢复对话书签） | `~/.pi/talk-sleep.jsonl` |
| **net-guard** | `extensions/net-guard.ts` | 事件 `session_start`(异步探测 pi.dev) `before_agent_start`(消息计数隐藏状态) `session_shutdown` | 无 |
| **put-http-proxy** | `extensions/put-http-proxy.ts` | 命令 `/put-http-proxy`（HTTP 代理 prompt 语法糖：空闲写编辑器/忙碌 followUp 排队） | 无 |
| **sysprompt-view** | `extensions/sysprompt-view.ts` | 命令 `/sysprompt`；事件 `before_agent_start`(捕获 systemPrompt) | 无 |
| **for-grok-4-5** | `extensions/for-grok-4-5/index.ts` | 事件 `session_start` `input` `message_end` `agent_end` `tool_call` `tool_result`（习性一：thinking 空转自动续写最多 3 次；习性二：连续 `bash true` 判定完成并 abort） | 内存计数 + `lib/continuation-guard.ts` 跨扩展抑制标志 |
| **editor-margin** | `extensions/editor-margin/index.ts` | `setEditorComponent`(CustomEditor 子类：圆角边框+可配边距) | 无 |
| disabled | `opencode-models.ts.disabled` `thinking-translator/index.ts.disabled` `todo-scanner.ts.disabled` | 未加载 | |

**lib/ 辅助库**（扩展共享，非扩展本体）：`subagent-run.ts`(隔离子进程执行+重试循环，627 行)、`subagent-retry.ts`(指数退避/可重试判定)、`subagent-investigation.ts`(失败调查包组装)、`subagent-supplement.ts`(补充指令 FIFO 队列，532 行)、`timeline.ts`(worker JSON 事件→有界轨迹归一化)、`gui-runner.ts`(Wails GUI 启动器 runGuiWindow/launchGuiWindow)、`notify-send.ts`(跨平台桌面通知+声音)、`continuation-guard.ts`(跨扩展抑制标志)、`auth.ts`(auth.json 读取)、`concurrency.ts`/`format-utils.ts`/`token-utils.ts`/`message-utils.ts`/`error-utils.ts` 等。

---

## D. 四个核心机制的深度小节

### D.1 subagent（trident-subagent）——进程级隔离的多 agent 编排

**实现方式**：没有任何 pi 内建原语，全部在扩展 + lib 层用 **spawn 隔离 pi 子进程** 拼出：
- 主进程扩展 `extensions/trident-subagent/index.ts` 注册工具 `subagent({task: string | string[]})`。`execute()` 同步等待全部 worker 返航（Promise.allSettled 语义：单 worker 失败/超时不影响兄弟）。
- worker 进程由 `lib/subagent-run.ts::defaultRunOnce` spawn：`pi --mode json -p --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files --model <worker模型> --extension custom-providers --extension pi-mcp-adapter [-e 额外扩展] [--tools 白名单] 任务：...`。**隔离**=关闭全部资源发现、只显式加载 providers/MCP 适配器/补充桥；env 注入 `PI_SUBAGENT=1`（防递归派发）、`PI_SUBAGENT_INBOX`、`PI_TASK_ID`（供 permission-gate 关联）。
- 返回采集：从子进程 stdout 逐行 JSON 解析 `message_end`/`tool_result_end`/`agent_end` 事件，聚合 usage（tokens/轮数/成本）、stopReason、错误消息、最终正文。
- **向 LLM 暴露的接口**：工具 `subagent`（TypeBox 参数 `task: string | string[]`），promptSnippet + 6 条 promptGuidelines 指导主 agent 何时/如何派发（"参数必须是整理好的完整任务说明而非原始发言"、"一个失败不终止其他 worker"、"失败项 investigation 路径先 read 读档指引"）。

**数据流**：主 agent 调 `subagent` → `runBatch`（前置校验 workerInboxIds + 预创建 inbox）→ 并行 `runSubagent`（每 worker 一个重试循环）→ worker 子进程跑 → 事件流实时回传 `status.ts` 的 `updateWorker`（合并写，终态立即落盘 `~/.pi/subagent-status.json`，250ms 合并延迟）→ 全部终态后汇总逐项结果（`#N STATUS exit=  stderr  investigation:` 片段）作为工具 content 返回主 agent。

**可靠性/恢复**：
- 重试：`runSubagent` 最多 `SUBAGENT_MAX_ATTEMPTS=6` 次，`isRetryableFailure`（timeout/非零退出/stopReason=error 才重试；aborted/用户取消不重试），指数退避 1s→30s 封顶，跨 attempt 累积 timeline 种子续接。
- 失败恢复包：重试彻底失败写 `lib/subagent-investigation.ts` 生成的**调查文件**（md 章节：任务/错误/最后步骤/stderr 尾/疑似写文件工具白名单提示），主 agent 按"读档指引+最终结论"低成本恢复现场，而非整文件灌回上下文。
- 终态分类：`SubagentError.status`（timeout/aborted 结构化字段）而非正则匹配错误文本；超时控制器（默认 600s）+ 外部 signal 双 AbortController 合并。
- GUI 观察：`/gui:subagents` 经 `lib/gui-runner.ts::launchGuiWindow` 异步拉起 Wails 窗口轮询状态文件；`/gui:trident-setup` 同步等待选择模型写回 `providers.roles.toml`。
- 反馈模式：`/subagent:feedback on` 后新 worker 只用 `read/bash/be-*` 白名单（`--tools` 精确名单不支持通配，从活跃工具名过滤 be- 前缀），be-* 失败由 be-error-recorder 追加 `~/.pi/subagent-be-errors.jsonl` 供离线审阅。
- 补充指令桥：主 agent 可向运行中 worker 的 inbox 队列投递指令，worker 内 `subagent-supplement-bridge` 在每个 `tool_execution_end` claim 一条并以 `⟦pi-supplement:v1⟧` wire 前缀 + `deliverAs:"steer"` 塞回（工具执行后、下次 LLM 调用前投递；send 失败尽力 release 回滚）。

**持久化格式**：`~/.pi/subagent-status.json`（运行时快照，GUI 轮询，进程结束即弃）、`~/.pi/subagent-feedback.json`（`{enabled}`）、`~/.pi/subagent-supplements/<inboxId>.json`（FIFO 队列，`.lock` 目录互斥 + 临时文件 rename 原子写 + stale mtime 回收 + 0o600）、`~/.pi/subagent-be-errors.jsonl`、tmp 下调查文件（`pi-subagent-*/`）、`providers.roles.toml`（模型路由，`[roles] worker=...`）。

> 对照：pi 官方示例 `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/` 提供更简单的版本（`agents.ts` 声明式 agent 定义、单/并行/链式 `{previous}` 三种模式、MAX_PARALLEL_TASKS=8、MAX_CONCURRENCY=4、输出 50KB 封顶），仓库版在此基础上加了重试/调查/状态 GUI/反馈模式。

### D.2 goal —— agent_settled 事件驱动的续行循环

**实现方式**：纯事件驱动 + `sendUserMessage` 注入，**没有持久化目标状态**（跨重启不恢复，重开会话即终止）。命令 `/goal <目标>` 或 `/goal gate:<命令> [目标]` 激活；核心循环挂在 `agent_settled`（真正停歇、无重试/压缩/续行剩余时触发）：
1. 取分支最后一条 assistant 消息，检测 `<summary>...</summary>` XML（`<plan>/<progress>/<next>` 协议）；
2. `<next>` 含待办列表（编号/checkbox/无序列表）→ 续行；含完成信号（"全部完成"/complete 等）→ 若配了 gate 命令则 `pi.exec("bash",["-c",gate])` 客观验证，exit 0 才算完成；无 XML → 直接续行但连续 3 轮无 XML 暂停；
3. 续行 = `setTimeout(300ms)` 后 `pi.sendUserMessage(buildContinuePrompt(...))`，提示词强制"每轮必须输出 <summary> XML"。

**向 LLM 暴露的接口**：无新工具，只靠 prompt 协议约束；gate 失败时把失败输出（截断 4000 字符）喂回模型要求修复重跑。

**可靠性**：`MAX_CONTINUE_ROUNDS=50` 总上限；`errorFingerprint`（头 500 字+尾 200 字、数字归一化）识别连续 3 次相同 gate 错误 → 暂停并附失败输出让用户介入；stopReason=`aborted`（用户 Esc）→ 停止；`error`（瞬态网络）→ 宽容重试不计数；`input` 事件在用户手动输入时重置计数；`message_end` 调 `markSuppressTaskComplete()` 抑制 task-notification 的"完成"误报；每 3 轮发带声音进度通知（`lib/notify-send.ts`）；状态经 `setStatus("goal")` + `setWidget("goal-status")` 展示。

**数据流**：`/goal` → 激活 → 首轮注入 → agent_settled → 解析 XML → gate 验证 → sendUserMessage 续行 → 循环 → 完成/暂停。未激活时自动检测"纯 `<summary>` 消息"并 `ctx.ui.confirm` 询问是否开启（记录 lastPromptedEntryId 防重复弹窗）。

### D.3 plan-mode —— 只读探索 + 步骤追踪（最完整的"状态机"式扩展）

**实现方式**：`/plan` 切换 `planModeEnabled`（工具集 `PLAN_MODE_TOOLS = read/bash/grep/find/ls/ask_question`，bash 走 `utils.ts::isSafeCommand` 白名单：破坏性模式正则 40 条 vs 安全只读模式 44 条），`/plan:start` 进入 `executionMode`（工具集恢复 `read/bash/edit/write`）。三态：plan（只读）→ executing（追踪）→ off。

**向 LLM 暴露的接口**：无新工具；靠 `before_agent_start` 注入 custom message（`[PLAN MODE ACTIVE]`/`[EXECUTING PLAN]`，`display:false` 只进上下文不进渲染）约束行为；`turn_end` 从 assistant 正文提取 `[DONE:n]` 标记更新待办完成态；`agent_end` 从 "Plan:" 段落提取编号待办 → `ui.select` 询问用户（执行/继续/细化/亲自掌舵）→ 执行模式用 `sendMessage(..., {triggerTurn:true})` 驱动；计划完成发 `plan-complete` custom message。

**持久化格式**：`pi.appendEntry("plan-mode", {enabled, todos, executing})` 写会话 JSONL（CustomEntry，不进 LLM 上下文）；`session_start` 恢复时重扫 `plan-mode-execute` 标记之后的消息重新计算 `[DONE:n]` 完成态（避免旧计划残留误判）；`context` 事件在关闭计划模式时过滤残留的 plan 上下文消息。

### D.4 补充：pi 官方 subagent 示例（可选参考路径）

`node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/`：`agents.ts` 声明式 agent（name/system prompt 从 prompts/ 目录读），工具支持单/并行/链式（`{previous}` 占位符串接前一个输出），`spawn pi --mode json -p` 捕获结构化输出，`withFileMutationQueue` 参与文件写队列防并发覆盖，ConcurrencyLimiter 限 4 并发。仓库版 trident-subagent 是它的超集（加重试/调查/GUI/反馈/补充桥）。

---

## E. 改本体（编译 pi）vs 写扩展：可行性对比

**改本体路径**（`docs/development.md`）：
- 源码在公开 monorepo **pi-mono**（`github.com/earendil-works/pi-mono`）：`packages/{ai, agent, tui, coding-agent}`；`npm install && npm run build`（tsgo 编译到 dist），`pi-test.sh` 从源码跑。
- 本地已装的 `node_modules/@earendil-works/pi-coding-agent` 的 dist 是**编译产物**（index.js + d.ts + sourcemap，无 src），`package.json` 的 `piConfig.configDir=".pi"`、`bin.pi=dist/cli.js`、`build:binary` 用 bun compile 出独立二进制。
- 成本评估：改本体需要 fork pi-mono → 改 `packages/coding-agent/src/` → 重新 build → 替换本地 node_modules 安装（npm/pnpm workspace 或直接覆盖），并承担后续版本升级的 rebase 成本；涉及面：**新增事件类型、改 agent 循环/重试/压缩算法、新增内建工具、改 provider 传输层、改会话文件格式**。
- 收益：只有这五类"平台级"改动必须走本体。当前仓库已实现的能力没有一项需要改本体。

**写扩展路径**：
- 扩展经 **jiti 运行时加载 TS，零编译**，放 `~/.pi/agent/extensions/*.ts` 或 `*/index.ts` 自动发现，`/reload` 热重载，可带 `package.json` 依赖（npm install 后自动解析），可 import `@earendil-works/pi-coding-agent` 的公开类型与运行时函数（`defineTool`/`createReadTool`/`createLocalBashOperations`/`withFileMutationQueue`/`SessionManager`/`truncate*`/`keyHint` 等）。
- 覆盖面证据：本仓库 24+ 扩展实现了 DSH 对应的全部能力面——subagent 编排（进程隔离+重试+恢复）、goal 续行循环、plan-mode 状态机、权限门（GUI+TUI 双通道）、会话浏览/搜索、任务通知、技能仓库管理、自定义 provider、工具检测、思考档位控制、流式监控、系统信息等；SDK（`createAgentSession`/`AgentSessionRuntime`/`SessionManager`）与 RPC 模式（JSON 协议 + extension UI 子协议）为嵌入方提供进程内与跨进程两种集成方式。
- 已知扩展层缺口（对应 A.4 限制）：①多 agent 编排没有一等公民支持（需自行 spawn 子进程，无法复用 DSH 的 goal 轮次/子代理持久会话语义）；②没有持久的"目标对象"（goal 状态不落盘、不跨重启）；③agent 循环语义（自动重试策略、压缩阈值触发）只能钩子观察不能改写；④无内置沙箱，权限控制只能靠 tool_call 拦截模拟（本仓库 permission-gate 即此模式），做不到 DSH 文件策略级别的强制。

**结论建议**：迁移 DSH 架构能力到 pi 时，**优先全部走扩展路径**（工具/命令/事件/UI/持久化五件套足够覆盖）；仅当需要"新事件类型"或"改 agent 主循环语义"时再评估 fork pi-mono 改本体。pi 与 DSH 的事件模型高度同构（session/turn/message/tool/provider 各层钩子几乎一一对应），迁移主要是把 DSH 的 goal 状态机、子代理生命周期管理翻译成"扩展 + lib + 文件队列 + 子进程 spawn"的形态。
