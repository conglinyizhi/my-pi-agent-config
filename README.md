# 我的 pi 配置

换电脑？一条命令的事。（该文档由人类和 agent 协作完成）

PS: 因为费用等原因，部分模型的使用是基于中转站的，因此，不代表模型的真实体验，部分插件可能不适用于这种情况（比如 **for-grok-4-5** ）

```bash
git clone git@github.com:conglinyizhi/my-pi-agent-config.git ~/.pi/agent
cd ~/.pi/agent && pnpm install
pi
```

第一次启动，`skill-boot` 会自动把第三方 skill 全拉下来（clone 进 skill-repo，软链接到 skill-vault），不用你操心。

## 里面有什么

### 扩展

**for-grok-4-5** — 「强大、实惠、但疯跑的孩子」。grok-4.5 两大顽疾补丁：①空正文自动续跑 ②连续 bash true 空转识别为正常收工。续跑提示还会引导 grok 用 `echo job done already` 主动报完成。

**skill-boot** — 技能引导与管理（skill-kit + skill-manual 合并）。启动时同步技能仓库（clone → skill-vault 软链接，pi 不扫描、启动更快）；`/skill-boot <名>` 引导注入指定 SKILL.md、`/skill-boot:list` TUI 列表选择、`/skill-manager` 交互式开关；同时负责系统提示词过滤。

**settings-sync** — settings.json 里有几个字段是 pi 自己改的（比如 lastChangelogVersion），不适合进 git。这个扩展把它们剔出去，只留干净的到 tracked.json。

**task-notification** — 任务跑完了弹个桌面通知，省得你时不时切回来看。支持 `/notify-sound-test` 测试音效。与 for-grok-4-5 协作：续跑中跳过「任务完成」通知。

**session-search** — 翻历史对话。AI 觉得你可能问过类似问题时自己会搜，注册了一个 search_sessions 工具。

**session-browse** — 跨 workdir 浏览与恢复历史 session。`/sessions` 命令列出所有对话，选中即切过去。

**subagent** — 把任务委派给子 agent 并行执行，支持 single / parallel / chain 三种模式。可选沙箱细粒度限制（配合 landlock-shell）：`sandbox_dir` 限制 worker 只能写指定目录（工程其余只读，适用于 worktree 隔离）、`readonly` 只读模式（不写 workspace）。

**confirm-destructive** — 在切换/分叉 session 前提醒，防手滑。

**plan-mode** — 注册了 `/plan` 命令。切到计划模式后只读探索不乱改，先想清楚再动手。计划生成后桌面通知带音效提醒确认；产出的计划步骤与 todo_write 共用同一份存储（`/dsh-todos` 查看）。

**custom-providers** — `/provider fast-add` 快速加模型供应商，`/provider reload` 重载配置。

**stream-monitor** — 偷偷盯着流式响应，变慢了你能察觉。

**status-bus** — 状态栏总线：在扩展与状态栏之间注入一层两侧抽象（`lib/status-bus.ts`）。对扩展零迁移——仍是原生 `ctx.ui.setStatus/setWidget/setWorking*`，总线透明记录进规范存储并透传 TUI（行为不变）；输出侧 `statusBus.subscribe()` 订阅同一份变更流，未来 web/文件/事件桥目标从这里接入。当前只接 TUI 一个目标。

**ask_question** — 注册了一个工具让 AI 能弹选项框问你，不用打字的确认体验好很多。多问题时 Tab 切换标签页。

**thinking-control** — `/thinking` 切换思考深度。

**thinking-translator** — 把模型非中文的 thinking 翻译成简体中文显示在 TUI 里。

**sysinfo** — `/sysinfo` 一键收集系统信息发给 LLM。

**sandbox-permissions** — 沙箱权限三合一扩展（`guard` 防读 + `gate` 审批 + `allow` 升权，一个目录三个子模块）：
- `guard`：敏感路径黑名单防护（恶意 skill 防护），初始化/reload 时读取 `sandbox-blacklist.json`（`~/.ssh`、浏览器密码、钱包、auth.json、`.env` 等 glob 模式），拦截 read/write/edit/bash 触碰黑名单路径
- `gate`：危险 bash 命令审批（token 化规则引擎判定 rm-recursive/find-delete/sudo/dd 等 gap 规则 + 动态构造降级），GUI 审计面板 + TUI 回退
- `allow`：DSH 升权移植，`sandbox-allow` 工具临时同意「单一指令」跨越沙箱（等价 `sandbox_permissions` + `justification`），审批并入 `gate` 窗口（`kind=sandbox-allow` 分支），授权只此一次、fail-closed，审计写会话日志

**talk-sleep** — `/talk-sleep [备注]` 暂存当前对话，换台电脑 `pi --resume` 继续聊。

**todo-scanner** — 扫描项目中的 TODO 注释，`/todos` 或 Ctrl+Shift+T 查看。

**tool-checker** — 注册工具检测器，用于调试工具是否正常工作。（开发用）

**editor** — 编辑器能力四合一：`/prompt-edit-gui`（Wails GUI，读 Ctrl+C 历史）、圆角边距输入框、Ctrl+C 历史保存（`cliphist.json`）、外部编辑器（Ctrl+O / `/open-editor`）。

**prompt-sections** — DSH 风格的有序段系统提示词组装（A/B 测试，对照 v0.1.0 tag）。`/prompt-sections on|off|status` 开关，`/prompt-sections-preview` 预览装配结果。plan-mode / skill-boot(原 skill-kit) / tool-checker / trident-routing 母港已迁移为段（order 约定：-100 身份 / 0 默认 / 50 策略 / 100-199 工具指导）。详见 `extensions/prompt-sections/README.md`。

**dsh-tools** — DSH 工具移植第一批：`todo_write`（全量快照任务列表，与 plan-mode 共用统一存储 `lib/todo-store.ts`，`/dsh-todos` 查看）与 `str_replace_editor`（view/create/str_replace/insert 四命令行号编辑工作流）。开关 `dshTodo` / `dshStrReplaceEditor`。

**dsh-goal** — DSH 事件溯源持久化目标 + 自动续行：`get_goal / create_goal / update_goal` 工具 + `/goal` 命令，会话日志折叠恢复，激活位进程本地不持久化。开关 `dshGoal`（默认开，旧 `<summary>` XML 版 `/goal` 扩展已退役，`"dshGoal": false` 可关闭）。

**dsh-jobs** — DSH 后台任务：`bash_background` 启动 + `job_output / job_list / job_kill` 管理，完成通知（wakeup 空闲开新轮次 / quiet 仅通知用户）。`/dsh-jobs` 查看。

### 暂时停用插件

**opencode-models** — `/model-more` 切换到从 opencode 导入的模型列表。

停用原因：因为不再使用 opencode，也没有 opencode go 套餐，唤醒 opencode 的流程已经不再必要

### 沙箱（bash 内核隔离）

**landlock-shell** — pi 的 bash 工具默认经 `scripts/sandbox-shell.mjs` 包装进
Landlock 内核文件系统沙箱（`scripts/vendor/landlock-run`，Go 实现，源码在
`scripts/vendor/landlock-run-go/`，`CGO_ENABLED=0 go build` 可重新构建）：
全系统只读 + 工作区/`/tmp` 可写，写工作区外由内核 EROFS 拒绝，无需逐条审批。配置：

- `settings.tracked.json` → `"shellPath": "~/.pi/agent/scripts/sandbox-shell.mjs"`（启用；删除即关闭）
- `"sandboxExempt": ["git push", "npm publish"]` —— 前缀命中的命令**完全权限开放**（不沙箱，用户显式信任）
- 环境变量 `LANDLOCK_RUN` 可覆盖 landlock-run 路径；缺失时 **fail-closed**（拒绝执行，绝不裸跑）
- `PI_SANDBOX_DISABLE=1` 强制透传（临时关闭沙箱/测试的逃生门）
- `PI_SANDBOX_RW_EXTRA=<dir>:...` 额外可写根，叠加在默认 cwd 之上（`sandbox-allow` 升权工具的 write-paths 通道）
- **平台支持**（`scripts/vendor/landlock-run-go/` 按 `//go:build` 分平台实现）：
  - **Linux**：Landlock（默认沙箱，`--ro /` 全读 + workspace/tmp 可写）
  - **macOS**：Seatbelt（`sandbox-exec` + SBPL profile，语义对齐 Linux；Apple 已标废弃但仍可用，与 DSH 同路线）
  - **Windows**：受限令牌 + NTFS ACL runner（`CreateRestrictedToken` WRITE_RESTRICTED + workspace 目录 Write ACE，对齐 DSH windows-acl）——**已实现但未经真机验证**，默认透传，设 `PI_SANDBOX_WINDOWS=1` 显式启用（真机验证通过前保持默认安全）

### Skill

> **手动注入策略（2026-08-16）**：除 `data-name` / `git-commit` / `which-pi-docs`
> 三个保留自动注入外，其余技能均标记 `disable-model-invocation: true`
> （自写 skill 在 SKILL.md frontmatter；第三方在 skill-repo/repo.toml 的
> `disable_model_invocation`），不出现在 `<available_skills>` 目录，模型不会自动读取。
> 需要时主动注入：`/skill:name`（pi 内建，加载并执行）或 `/skill-read <名>`
> （把 SKILL.md 全文注入会话上下文）。TUI 常驻一行提示当前手动候选数。

自己写的 skill（除 which-pi-docs 外全部在 `skill-vault/clyzhi/`，手动引导注入）：

**data-name** — 前端元素标注，给关键交互节点加 data-name 属性，AI 定位元素不用猜 class 名。已移至 `~/.agents/skills/data-name`（跨 agent 通用位置）。

**lazycat-dev** — 懒猫微服那套开发流程，打包、部署、认证全涵盖。

**which-pi-docs** — pi 自身的文档导航。问 pi 本身的问题时会自动翻。

**git-commit** — 分析 Git 差异并生成符合约定式提交规范的中文 commit message。已移至 `~/.agents/skills/git-commit`（跨 agent 通用位置，含 pre-commit-check.ts 等辅助文件）。

**skill-kit** — 技能工具箱，导入外部技能仓库、从零创建新技能。

第三方 skill（详情参阅 [skill-repo/repo.toml](skill-repo/repo.toml)）：

华夏技能（瘦身后热装 4 个：nopua / tiangong / bibuzaohua / paoding-jieniu；其余除名，核并入 skills/clyzhi）

moonbit 开发套件

fount-char

## 通知音效

完成任务那一声的音效素材来自 Freesound 上的 Coghezzi，CC BY 4.0 授权。详情可见 [assets/sounds/ATTRIBUTION.md](assets/sounds/ATTRIBUTION.md)
