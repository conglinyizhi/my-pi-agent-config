# 我的 pi 配置

换电脑？一条命令的事。（该文档由人类和 agent 协作完成）

PS: 因为费用等原因，部分模型的使用是基于中转站的，因此，不代表模型的真实体验，部分插件可能不适用于这种情况（比如 **for-grok-4-5** ）

```bash
git clone git@github.com:conglinyizhi/my-pi-agent-config.git ~/.pi/agent
cd ~/.pi/agent && pnpm install
./hub/install.sh    # Linux：编装 pi-hub；有 lark-cli 才启飞书通道
pi
```

第一次启动，`skill-boot` 会自动把第三方 skill 拉到 `skill-repo`，并暴露到正式发现路径 `skills/external`。它们默认不进入模型自动发现提示；看到新增技能提示后，用 `/skillful` 自己开启。

## 里面有什么

### 扩展

**for-grok-4-5** — 「强大、实惠、但疯跑的孩子」。grok-4.5 两大顽疾补丁：①空正文自动续跑 ②连续 bash true 空转识别为正常收工。续跑提示还会引导 grok 用 `echo job done already` 主动报完成。

**skill-boot** — 技能来源同步与过渡期手动注入。启动时同步技能仓库（clone → `skills/external` 正式发现入口）；`/skill-boot <名>` 注入指定 SKILL.md。外部技能默认隐藏，技能发现与可见性统一交给 Pi / skillful。

**skillful-local** — 从 `pi-skillful` 迁移的精简核心：发现 Git 仓库外层的 `.agents/skills/` 与 `skills/external` 正式入口，统一管理模型自动发现的技能可见性，并支持在输入任意位置显式调用 `/skill:name`。外部技能及后续新发现技能默认隐藏，只提示用户自行开启；`/skillful` 的来源组规则写在 `extensions.toml` 的 `[skillful.skillGroups]`（`match` 按 canonical path 片段归组、`singletonPackages` 收单包，都不硬编码在源码里），当前分四组：MoonBit 开发环境、华夏技能、辅助技能（单包兑底）、以及按包名/来源自动分的其余项。排除了安装遥测和会话快捷键。许可证与归属见 `extensions/skillful/`。

**settings-sync** — settings.json 里有几个字段是 pi 自己改的（比如 lastChangelogVersion），不适合进 git。这个扩展把它们剔出去，只留干净的到 tracked.json。

**task-notification** — 任务跑完了弹个桌面通知，省得你时不时切回来看。支持 `/notify-sound-test` 测试音效。与 for-grok-4-5 协作：续跑中跳过「任务完成」通知。

**session-search** — 翻历史对话。AI 觉得你可能问过类似问题时自己会搜，注册了一个 search_sessions 工具。

**session-browse** — 跨 workdir 浏览与恢复历史 session。`/sessions` 命令列出所有对话，选中即切过去。

**subagent** — 把任务委派给子 agent 并行执行，支持 single / parallel 两种模式。复杂任务可传结构化简报：`objective`、`context`、`constraints`、`required_files`、`skills`、`acceptance`、`output_format`，让 worker 一次拿齐背景与验收标准；`task` 传数组时每个元素都必须是结构化简报对象（裸字符串会被派工前校验当场拒绝——长简报漏写数组收尾的 `]` 时，后面的 `"timeout"` 会掉进数组被当成一个完整任务派出去，白烧一个 worker 预算）。模型优先级为显式 `model: provider/model` > 用户通过 `/subagent:select-change-switch-default-worker-model` 设置的独立 worker 默认 > 当前 session。独立默认不改变当前 session，选择器内可恢复继承。可选沙箱细粒度限制（配合 landlock-shell）：`sandbox_dir` 限制 worker 只能写指定目录（工程其余只读，适用于 worktree 隔离）、`readonly` 只读模式。沙箱参数在派工前校验：`sandbox_dir` 必须已存在、与只读档位互斥，不做静默降级。写入边界对 bash 与 write/edit 一起生效（readonly 只有 `/tmp` 可写，worktree 是 `sandbox_dir` 及其子目录）。实时监视使用 `/subagent:gui`；面板上的耗时一律双格式（`128s（00:02:08）`），秒数对着预算/超时看，时分秒对着时钟看。`/subagent:stop` 强停时，worker 侧拿到的是带标记的中止（不是超时/失联）：终态文案会写明「用户强制停下（/subagent:stop）+ 理由」，并给出现场位置——调查文件（压缩摘要 + 路径线索）与批次诊断档案 `~/.pi/subagent-diagnostics/<batchId>.json`（完整可见轨迹），同时提醒主 agent 不要自动重试或原样重派。worker 系统提示里也写死了包管理器约定：装包/跑 CLI 一律 pnpm（`pnpm dlx` 替 npx），禁 npm/yarn（worker 不加载 tool-checker，拿不到主 agent 那份提示）。

**confirm-destructive** — 在切换/分叉 session 前提醒，防手滑。

**plan-mode** — 注册了 `/plan` 命令。切到计划模式后只读探索不乱改，先想清楚再动手。计划生成后桌面通知带音效提醒确认；产出的计划步骤与 todo_write 共用同一份存储（`/dsh-todos` 查看）。

**custom-providers** — `/provider fast-add` 快速加模型供应商，`/provider reload` 重载配置；`/provider fast-edit` 交互改配置，`/provider fast-edit-with-copy` 复刻已有模型到别的供应商再微调。长列表用 `lib/vim-select.ts`：`[num]j` / `[num]k` 计数跳转、`/` 模糊过滤（行尾标英文别名）；数字输入用 `lib/prompt-with-preview.ts` 实时换算 `1M` → `1,000,000`。

**model-selection** — `/model:select-current-session-model [provider/model]`、`/model:change-current-session-model [provider/model]` 与 `/model:switch-current-session-model [provider/model]`：用户主动选择并设置当前 session 模型。所有使用该库的插件共享 `~/.pi/agent/model-selection.toml`，按功能 scope 分别记录最多 4 条 `recent` 和局部 `pinned`，另有所有功能共用的全局置顶；选择后可确认、当前功能置顶或所有功能置顶，点击置顶模型时也可取消对应置顶或返回上一级。不向模型暴露选择工具，也不修改 `settings.json` 的默认模型。subagent 未设置独立默认时继承当前 session；显式传入 `model` 时只覆盖本次 worker。

**stream-monitor** — 偷偷盯着流式响应，变慢了你能察觉。

**status-bus** — 状态栏总线：在扩展与状态栏之间注入一层两侧抽象（`lib/status-bus.ts`）。对扩展零迁移——仍是原生 `ctx.ui.setStatus/setWidget/setWorking*`，总线透明记录进规范存储并透传 TUI（行为不变）；输出侧 `statusBus.subscribe()` 订阅同一份变更流，未来 web/文件/事件桥目标从这里接入。当前只接 TUI 一个目标。

**ask_question** — 注册了一个工具让 AI 能弹选项框问你，不用打字的确认体验好很多。多问题时 Tab 切换标签页。

**thinking-control** — `/thinking` 切换思考深度。

**thinking-translator** — 把模型非中文的 thinking 翻译成简体中文显示在 TUI 里。

**sysinfo** — `/sysinfo` 一键收集系统信息发给 LLM。

**fragments** — 输入框里打 `&名字`，按回车换成 `~/.pi/agent/fragments.toml` 里那段正文（随便多少行，比 prompt 模板更适合一句话级别的插入件）。只认行首或空白后的 `&名字`：`&&`、URL 里的 `&`、代码块与反引号里的内容都不碰。一条正文可以挂多个触发词（`aliases`，改内容只改一处）。名字允许字母、数字、下划线、连字符与冒号。另有 `&名字(参数)` 形式的动态调用：带括号时交给注册的 provider 展开（可返回文本 + 图片，如 `&img(3)` 把第 3 张照片附到这条消息上）。还有 `/frag:build <名字>`（把正文插进输入框改完再发）、`/frag:list`（列表选中即插入）与输入 `&` 时的候选补全。配置改完不用 `/reload`（按 mtime 重读）。真身在 `~/.pi/agent/fragments.toml`，本机私有不入库；换机器从 `fragments.toml.example` 复制一份就行。详见 `extensions/fragments/README.md`。

**sandbox-permissions** — 沙箱权限三合一扩展（`guard` 防读 + `gate` 审批 + `allow` 升权，一个目录三个子模块）：
- `guard`：敏感路径黑名单防护（恶意 skill 防护），初始化/reload 时读取 `extensions.toml` 的 `[sandbox-guard]`（`~/.ssh`、浏览器密码、钱包、auth.json、`.env` 等 glob 模式），拦截读写触碰黑名单路径——覆盖内置 `read`/`write`/`edit` 与 better-edit-tools 的 `be-read`/`be-write`/`be-replace`/`be-insert`/`be-delete` 等直挂通道；同时把 subagent 的 `readonly` / `sandbox_dir` 边界补到写入类工具上（worker 只能写 `/tmp` 或派工指定的可写根，越界直接拒绝）
- `gate`：危险 bash 命令审批（token 化规则引擎判定 rm-recursive/find-delete/sudo/dd 等 gap 规则 + 动态构造降级），GUI 审计面板 + TUI 回退。规则按「会执行什么」看文本：heredoc 正文默认算数据（`cat > x.sh <<EOF` 里写的 `rm -rf` 不命中，无引号定界也一样），只有真会被 shell 跑起来的正文才算（`bash <<'EOF'`、`cat <<'EOF' | bash`）；命令替换另算，它在写入时就展开执行，照旧拦。审批窗把命令里**写死的赋值**（`export FOO=…` 与 `FOO=1 cmd`）按 shell 规则解析后标绿，悬停显示解析结果；解析不了的标灰并说明原因（含 `$(...)`、引用了环境里没有的变量——那多半是 shell 会话里定义的）
- `allow`：DSH 升权移植，`sandbox-allow` 工具临时同意「单一指令」跨越沙箱（等价 `sandbox_permissions` + `justification`），审批并入 `gate` 窗口（`kind=sandbox-allow` 分支），授权只此一次、fail-closed，审计写会话日志。命令引用敏感路径（`.env` 这类最常被黑名单误伤的项目配置文件）时不硬拒，而是转成这次人工审批并在窗口里标出命中的那一段；普通 bash 与 worker bash 仍直接拒绝（没有同意出口）

**talk-sleep** — `/talk-sleep [备注]` 暂存当前对话（备注必填，未带则弹框索取），换台电脑 `pi --resume` 继续聊；`/talk-sleep-load` 选暂存项复制恢复指令，可顺手编辑备注。

**todo-scanner** — 扫描项目中的 TODO 注释，`/todos` 或 Ctrl+Shift+T 查看；TODO 调度 GUI 使用 `/routing:gui`（`/gui:scan-todo` 为兼容别名）。

**tool-checker** — 注册工具检测器，用于调试工具是否正常工作。（开发用）

**editor** — 编辑器能力四合一：`/editor:gui`（Wails GUI，读 Ctrl+C 历史；`/prompt-edit-gui` 为兼容别名）、圆角边距输入框、Ctrl+C 历史保存（`cliphist.json`）、外部编辑器（Ctrl+O / `/open-editor`）。

**prompt-sections** — DSH 风格的有序段系统提示词组装（A/B 测试，对照 v0.1.0 tag）。`/prompt-sections on|off|status` 开关，`/prompt-sections-preview` 预览装配结果。plan-mode / skill-boot(原 skill-kit) / tool-checker / trident-routing 母港已迁移为段（order 约定：-100 身份 / 0 默认 / 50 策略 / 100-199 工具指导）。详见 `extensions/prompt-sections/README.md`。

**dsh-tools** — DSH 工具移植第一批：`todo_write`（全量快照任务列表，与 plan-mode 共用统一存储 `lib/todo-store.ts`，`/dsh-todos` 查看）与 `str_replace_editor`（view/create/str_replace/insert 四命令行号编辑工作流）。开关 `dshTodo` / `dshStrReplaceEditor`。

**dsh-goal** — DSH 事件溯源持久化目标 + 自动续行：`get_goal / create_goal / update_goal` 工具 + `/goal` 命令，会话日志折叠恢复，激活位进程本地不持久化。开关 `dshGoal`（默认开，旧 `<summary>` XML 版 `/goal` 扩展已退役，`"dshGoal": false` 可关闭）。

**dsh-jobs** — DSH 后台任务：`bash_background` 启动 + `job_output / job_list / job_kill` 管理，完成通知（wakeup 空闲开新轮次 / quiet 仅通知用户）。`/dsh-jobs` 查看。

### 暂时停用插件

**opencode-models** — `/model-more` 切换到从 opencode 导入的模型列表。

停用原因：因为不再使用 opencode，也没有 opencode go 套餐，唤醒 opencode 的流程已经不再必要

### 审批 hub（本机守护）

人工审批（bash / sandbox-allow / subagent capability）优先问本机 `pi-hub`，一台机器一个，Unix socket `~/.pi/agent/run/hub.sock`，systemd --user。hub 在线时闸门窗由 hub 拉起，和已连接的 IM 适配器扇出，先合法应答赢。hub 没起来回退原来的 GUI→TUI。

- 新机 / 改完代码：`hub/install.sh`（`--reload` 热更，`--status` 看状态）。看服务用 `systemctl --user`，不要用系统级 systemctl
- 贴码 `/remote:allow-key PIHUB-…`；许可窗 `/remote:gui`（yad）；状态 `/remote:status`
- 飞书走本机 `lark-cli`（`hub/adapters/feishu/`）。没有 CLI：`pnpm add -g @larksuite/cli && lark-cli config init && lark-cli auth login`，然后 `systemctl --user start pi-hub-feishu.service`。缺 CLI 时适配器退出码 78，不再狂重启
- 主线只推 Linux。别的系统从 tag `pre-linux-hub` 自己接（没有归档分支，checkout tag 看）。未公开 IM 适配器放 `hub/private/`，不入库

### 手机照片网关（pi-photo）

手机拍照传到主机，编成短号（1..99）；要用哪张就在输入框里写 `&img(3)`，展开时那张图直接附到这条消息上。照片不自动进会话，什么时候用哪张由你定。守护 `pi-photo`（systemd --user，与 hub 并列），上传地址由 `/photo:url` 给出（带口令，附终端二维码）。

- 装 / 热更：`photo/install.sh`（`--reload` 热更、`--status` 看状态）。口令在 `~/.pi/agent/photo-state/token`
- pi 侧：`/photo:url` 拿上传地址，`/photo:list` 看池子里有哪些；引用用 `&img(3)`，旧图直接写绝对路径 `&img(/abs/path.jpg)`
- 编号池默认 99（`-pool` 可改）：取最小空号，池满了回收最久没被引用过的那张；被回收的图文件仍在 `archive/日期/` 下，所以旧路径永远能用
- 默认监听 `0.0.0.0:8787`（`-addr` 可改）。口令只挡同一 wifi 里的随手访问，不是鉴权边界，别往公网放

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

### 调试设备锁与派工内存闸

**内存闸**——worker 的内存墙是「**每条命令**」1GiB（`scripts/sandbox-shell.mjs` 的默认，升到更大要走 `sandbox-allow` 的 `memoryMb`），而并发安全阀只数 worker 个数，两者叠起来能把 15G 的桌面机推进交换。所以派工前会读一次 `MemAvailable`，按「(可用 − 保留) ÷ 每 worker 计划值」算出本次真实并行上限，超出的 worker 照旧排队（面板显示排队），依据写进派工回报。

- 两个数在 `extensions.toml` 的 `[subagent-memory]`：`reserveMb`（留给桌面与主 agent，缺省 2048）与 `planMb`（每个 worker 的典型占用计划值，缺省 512）。**这是计划值，不是命令墙**：墙的语义与 1GiB 默认都不动，把墙调低只会让本来能跑的命令变成 137，而且模型看不到原因
- 内存紧张到不够一个计划值时仍开 1 个（一个都不开比超订更难用），并在回报里写明「内存紧张，其余排队」

### 命令事实层（preshell）

敏感路径判定不再拿黑名单模式对整条命令做子串匹配，而是先问事实层：
[preshell](https://github.com/conglinyizhi/preshell) 是独立子进程的静态分析器（MoonBit，GPL-3.0-or-later，
许可停在进程边界上），命令走 stdin、stdout 出 JSON，报出这条命令碰了哪些路径（读/写/删/网络）、
跑了什么程序、哪里看不懂。它不做裁决，策略仍在本仓（`lib/sandbox-check.ts`）。

判定分三层，各盖一个洞：

| 层 | 盖的洞 | 例子 |
|---|---|---|
| preshell 目标 | 相对路径、带引号的路径、`cd` 后的基准、`$HOME/x` 这类变量目标（v0.3.0 起由我们收尾成绝对路径） | `cd ~/.pi/agent && sed -n '610,630p' providers.toml`（旧子串匹配漏掉，实测语料里漏了 21 条）、`cat "$HOME/.ssh/id_rsa"`（引号里，token 层盖不到） |
| 未引号路径 token | 存在性探测这类不产生 Read 效果的用法 | `test -f .env`（preshell 对 `test` 只报 Exec） |
| 解释器/脚本载荷退回旧匹配 | 解释器与本地脚本的命令行字符串/heredoc 里的路径 | `node <<EOF` 里 `readFileSync('凭据文件')` |
| （事实层不可用）退整条旧匹配 | 缺二进制/超时/坏 JSON/schema 不符 | 宁可多拦，不能因为缺工具而变宽 |

误伤那一侧就是这次接入的目的：引号里的字符串（`grep -rn "process.env"`）、词内片段（`env-prep.sh`）、
模板文件名（`.env.example`）、提交信息里提到 `.env` 都不再拦。

- 配置在 `extensions.toml` 的 `[preshell]`（`enabled`/`bin`/`timeoutMs`/`schema`）；二进制缺省在
  `~/.pi/runtime/preshell`（不在 `/tmp`，重启不丢），也可用环境变量 `PRESHELL_BIN` 覆盖
- **v0.3.0 起路径一律输出绝对路径**，`--cwd=<绝对路径>` 事实上必填（它是「这条命令会在哪个目录里跑」
  的断言，不是 `cd`，命令内部的 `cd` 优先）。我们传的就是 `checkCommand` 拿到的 `ctx.cwd`；
  传进来的不是绝对路径时不猜，退回「不给 `--cwd`」（报告会自己标 `uncertain` 并附一条 Note），
  原值记在 `facts.cwdRejected`
- **变量的收尾是调用方的事**（integration.md 的「谁来替换那些变量」）：工具不读环境，对 `$HOME/x`、`~/x`、`~+/x`
  这类词首运行时展开的目标只交出原值与要替换的名字（每条 effect 的 `vars`，并集在 `impact.vars`），
  由 `lib/preshell.ts` 的 `resolvePath` 用本机环境变量做**字面**替换，再拿 `impact.cwd` 收成绝对路径。
  只替换 `vars` 报出来的名字（`dynamic: false` 的 `'$X/y'`、`~user`、`~N`、`$1`/`$@` 都不动），
  替换值一律用函数形式给 `replaceAll`（字符串形式会把值里的 `$&`/`$1` 当模板展开）；值没设、
  或替换完仍带 `$`/词首 `~` 就保留原值并标不确定（`$PWD` 用我们断言的 cwd，`$OLDPWD` 不用
  pi 进程那个值）。收尾失败时原值照旧参与判定，不会比接入前更松
- 每次调用：裸起进程 ~2ms（与 `/bin/true` 同量级），走我们这层（Node spawn + JSON）实测 p50 ~5ms、p95 ~8ms；
  分析本身只有 5µs/命令（它自己的 `--bench`：20000 条 112ms），所以成本全在进程环节；
  同一条命令在会话内只问一次（有界缓存）
- 单次上限 **100ms**。依据：本机 4.7 万条真实命令 p99.9 是 8KB、最大 22KB（对应几毫秒），
  病态输入也只有 1MB heredoc 18ms、5000 段串联 11ms；真正的收益在坏情况，二进制卡住时
  每条命令的阻塞从 2s 降到 100ms
- **批量调用走 `--stream`（v0.2 起）**：一个子进程跑完整轮，请求按 JSONL 进、报告按 JSONL 出，
  带 id 的信封保证「应答配得上请求」。实测（2500 条真实命令的冻语料，两份报告 diff 逐行相同）：
  单条模式 30s / p50 4.2ms，流式 20s / p50 0.3ms，全程只起 1 个进程（2500 条请求）。
  省下的是进程而不是分析（分析本身 5µs/条）。实时路径仍旧一条命令起一次进程：那边一次只问一句，
  2ms 无所谓，而改成异步要动整条同步判定链，不值当
  （客户端在 `lib/preshell-stream.ts`，harness 加 `--no-stream` 可回到单条对照；
  v0.1 那种不认 `--stream` 的二进制会自动退回单条。v0.3.0 的 `--cwd` 同样是**进程级**参数
  （批量模式不认逐条 cwd）：`scripts/preshell-shadow.ts` 按 cwd 分组跑，同一时刻只留一个子进程）
- 流式客户端父进程这一侧兜三件事：每条请求有自己的超时；子进程一退出，发给它的未决请求全判失败
  （事件可能迟到，所以按子进程记账，不牵连新起的那一个）；id 对不上的应答只记数、绝不当成功。
  闲下来（默认 60s）收工，宿主退出时把子进程带走（`unref` + exit 钩子，不拖住宿主退出）
- **没装/装坏也能工作**：拿不到报告时判定退回旧匹配（token 层仍然在，所以不会比接入前更松），
  不抛异常、不静默放行；TUI 会提醒一次并附上安装命令，状态栏常驻 `✗ 事实层 <原因>`，恢复后自动收掉；
  能动手解决的原因（缺件 / schema 不符 / 关掉）另发一条桌面通知，经 hub/IM 用 pi 没有 TUI 时靠它到人
  （`PI_NO_DESKTOP_NOTIFY=1` 可关）
- **熔断**：分两类。确定性失败（缺件/schema 不符）一次就断；瞬时失败（超时/坏 JSON/非零退出）
  要连续 5 次，因为 100ms 之后这类更常见，而误熔断的代价是整个会话退回旧匹配（误报全回来）。
  真卡死的二进制最多担误 5 × 100ms。`/reload` 或重启后重试

  实测（缺件 / 卡死两种）：

  ```
  缺件：拦下 cat .env（8ms，facts=missing）· 提示「事实层不可用：未安装或路径不对」+ 安装命令
  卡死：第 1..5 次各 ~101ms（timeout）→ 熔断 → 第 6 次 0ms；熔断后审计 1.1ms
  ```

- 事实还随命令一起交给 LLM 预审（`lib/preshell.ts` 的 `formatFacts` → `llm-review` 的 prompt）：
  模型看到的是影响面，不再只是一条命令原文
- 残余缺口（有意为之）：引号里的**远端**路径不再拦（`ssh host 'ls ~/.ssh'` 里的 `~/.ssh` 是远端），
  要恢复就把 `ssh` 加进 `lib/sandbox-check.ts` 的解释器名单，代价是正当运维流程被挡。远端的 heredoc 正文同理
  （`ssh host 'bash -s' <<EOF` 那一段本机不管）
- 解释器那层兜底只扫**交给解释器的那段载荷**：`-e` / `-c` 的参数、会被解释器消费的 heredoc 正文。
  自己写的脚本正文（`cat > x.ts <<EOF`，之后再用 node 跑）、`apply_patch` 的补丁、`git commit -F - <<EOF`
  的提交信息都不再当路径——实测语料里 10 条这类命令不再多问一次，而 136 条真敏感路径照旧拦下。
  残余：载荷正文里出现敏感字样（哪怕只是个字符串常量）仍会问；这是保守一侧的边界，不改
- 黑名单的命令匹配加了两侧词边界：`process.env`、`os.environ`、`.envrc` 里的 `.env` 不再算命中
  （实测从 26 条降到 3 条），`cat .env` / `foo/.env` / `../../.env` / `~/.ssh/id_rsa` 照旧命中
- 报告被截断（`effects_dropped` / `issues_dropped` > 0）或 `status=Invalid` 时不拿它当完备集合：
  整条退回旧匹配。真实命令里几乎撞不到（抽样 3105 条全为 0），但它标的就是「这份影响面不完整」。
  `uncertain` 不在此列：它在真实命令里占 65%，拿它降级等于把误报全带回来
- 复测：`node --experimental-strip-types scripts/preshell-shadow.ts --mode blacklist --n 0 --dump /tmp/x`
  （新旧路径判定逐条对比；`--mode transitions` 是策略档位对比，报告开头会打二进制 version/schema/sha）
### 设备锁（调试设备互斥）

`scripts/with-device-lock.sh` 给同一台物理设备（adb serial、串口、烧录器这类独占目标）上一把跨进程互斥锁。

为什么需要：多开 pi 的各个主 agent、每批的多个 worker 都是独立进程，而 adb server 全局共享。同一个 serial 上并发 `install` / `push` / `port` / `adb tcpip` 会互相踩，症状是「命令莫名失败」或「设备状态突变」。仓库里原先没有任何跨进程锁。

```bash
with-device-lock.sh emulator-5554 -- adb -s emulator-5554 install app.apk
with-device-lock.sh --wait 600 my-phone -- adb -s my-phone shell am force-stop com.x
with-device-lock.sh --status emulator-5554     # 只看谁占着，不抢锁
```

- 锁是 `/tmp/pi-device-<标识>.lock` 上的 `flock`：进程被杀也会由内核释放，不会留死锁；`/tmp` 是内存盘，主 agent 与各沙箱档位都放行写
- 拿不到锁默认等 300s 后以退出码 3 失败，并把当前持锁者（pid / 时间 / `PI_TASK_ID` / cwd / 命令）打出来，不静默降级
- 约定写在两处：`extensions.toml` 的 tool-checker hint（主 agent 系统提示）与 worker 系统提示里的「设备边界」；人手跑设备命令不受管，所以这条得当真执行

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
