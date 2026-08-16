# 我的 pi 配置

换电脑？一条命令的事。（该文档由人类和 agent 协作完成）

PS: 因为费用等原因，部分模型的使用是基于中转站的，因此，不代表模型的真实体验，部分插件可能不适用于这种情况（比如 **for-grok-4-5** ）

```bash
git clone git@github.com:conglinyizhi/my-pi-agent-config.git ~/.pi/agent
cd ~/.pi/agent && pnpm install
pi
```

第一次启动，`skill-kit` 会自动把第三方 skill 全拉下来，不用你操心。

## 里面有什么

### 扩展

**for-grok-4-5** — 「强大、实惠、但疯跑的孩子」。grok-4.5 两大顽疾补丁：①空正文自动续跑 ②连续 bash true 空转识别为正常收工。续跑提示还会引导 grok 用 `echo job done already` 主动报完成。

**skill-kit** — 技能管理一体化工具箱。启动时自动同步技能仓库（clone + 软链接），/skill-manager 开关技能，同时负责系统提示词过滤和技能预检唤醒。换机器的底气全靠它。

**settings-sync** — settings.json 里有几个字段是 pi 自己改的（比如 lastChangelogVersion），不适合进 git。这个扩展把它们剔出去，只留干净的到 tracked.json。

**task-notification** — 任务跑完了弹个桌面通知，省得你时不时切回来看。支持 `/notify-sound-test` 测试音效。与 for-grok-4-5 协作：续跑中跳过「任务完成」通知。

**session-search** — 翻历史对话。AI 觉得你可能问过类似问题时自己会搜，注册了一个 search_sessions 工具。

**session-browse** — 跨 workdir 浏览与恢复历史 session。`/sessions` 命令列出所有对话，选中即切过去。

**subagent** — 把任务委派给子 agent 并行执行，支持 single / parallel / chain 三种模式。

**permission-gate** 和 **confirm-destructive** — 一个拦危险命令（rm -rf 之类），一个在切换/分叉 session 前提醒，防手滑。

**protected-paths** — .env、node_modules 之类碰不得的路径直接挡住，免得不小心写坏。

**plan-mode** — 注册了 `/plan` 和 `/todos` 两个命令。切到计划模式后只读探索不乱改，先想清楚再动手。计划生成后桌面通知带音效提醒确认。

**custom-providers** — `/provider fast-add` 快速加模型供应商，`/provider reload` 重载配置。

**stream-monitor** — 偷偷盯着流式响应，变慢了你能察觉。

**ask_question** — 注册了一个工具让 AI 能弹选项框问你，不用打字的确认体验好很多。多问题时 Tab 切换标签页。

**thinking-control** — `/thinking` 切换思考深度。

**thinking-translator** — 把模型非中文的 thinking 翻译成简体中文显示在 TUI 里。

**sysinfo** — `/sysinfo` 一键收集系统信息发给 LLM。

**talk-sleep** — `/talk-sleep [备注]` 暂存当前对话，换台电脑 `pi --resume` 继续聊。

**todo-scanner** — 扫描项目中的 TODO 注释，`/todos` 或 Ctrl+Shift+T 查看。

**tool-checker** — 注册工具检测器，用于调试工具是否正常工作。（开发用）

**editor-margin** — 调编辑器边距，虽然小但舒服。

**prompt-sections** — DSH 风格的有序段系统提示词组装（A/B 测试，对照 v0.1.0 tag）。`/prompt-sections on|off|status` 开关，`/prompt-sections-preview` 预览装配结果。plan-mode / skill-kit / tool-checker / trident-routing 母港已迁移为段（order 约定：-100 身份 / 0 默认 / 50 策略 / 100-199 工具指导）。详见 `extensions/prompt-sections/README.md`。

**dsh-tools** — DSH 工具移植第一批：`todo_write`（全量快照任务列表，appendEntry 持久化，`/dsh-todos` 查看）与 `str_replace_editor`（view/create/str_replace/insert 四命令行号编辑工作流）。开关 `dshTodo` / `dshStrReplaceEditor`。

**dsh-goal** — DSH 事件溯源持久化目标 + 自动续行：`get_goal / create_goal / update_goal` 工具 + `/dsh-goal` 命令，会话日志折叠恢复，激活位进程本地不持久化。开关 `dshGoal`（默认关，与旧 `/goal` 扩展 A/B 共存）。

**dsh-jobs** — DSH 后台任务：`bash_background` 启动 + `job_output / job_list / job_kill` 管理，完成通知（wakeup 空闲开新轮次 / quiet 仅通知用户）。`/dsh-jobs` 查看。

**skill-manual** — 手动注入技能：TUI 常驻区域展示「已安装但不可自动注入」的技能清单，`/skill-read <名>` 把 SKILL.md 全文注入会话上下文（配合下方 Skill 手动注入策略）。

### 暂时停用插件

**opencode-models** — `/model-more` 切换到从 opencode 导入的模型列表。

停用原因：因为不再使用 opencode，也没有 opencode go 套餐，唤醒 opencode 的流程已经不再必要

### Skill

> **手动注入策略（2026-08-16）**：所有技能已标记 `disable-model-invocation: true`
> （自写 skill 在 SKILL.md frontmatter；第三方在 skill-repo/repo.toml 的
> `disable_model_invocation`），不再出现在系统提示词的 `<available_skills>` 目录，
> 模型不会自动读取。需要时主动注入：`/skill:name`（pi 内建，加载并执行）或
> `/skill-read <名>`（把 SKILL.md 全文注入会话上下文）。TUI 常驻区域会列出候选清单。

自己写的 skill（全部手动注入）：

**data-name** — 前端元素标注，给关键交互节点加 data-name 属性，AI 定位元素不用猜 class 名。

**lazycat-dev** — 懒猫微服那套开发流程，打包、部署、认证全涵盖。

**which-pi-docs** — pi 自身的文档导航。问 pi 本身的问题时会自动翻。

**git-commit** — 分析 Git 差异并生成符合约定式提交规范的中文 commit message。

**skill-kit** — 技能工具箱，导入外部技能仓库、从零创建新技能。

第三方 skill（详情参阅 [skill-repo/repo.toml](skill-repo/repo.toml)）：

华夏技能（瘦身后热装 4 个：nopua / tiangong / bibuzaohua / paoding-jieniu；其余除名，核并入 skills/clyzhi）

moonbit 开发套件

fount-char

## 通知音效

完成任务那一声的音效素材来自 Freesound 上的 Coghezzi，CC BY 4.0 授权。详情可见 [assets/sounds/ATTRIBUTION.md](assets/sounds/ATTRIBUTION.md)
