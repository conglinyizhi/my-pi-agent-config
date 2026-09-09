# sandbox-permissions（沙箱权限：guard / gate / allow）

一个扩展、三个子模块，覆盖 pi 沙箱权限全链路：

| 子模块 | 职责 | 注册 |
|--------|------|------|
| `guard.ts` | 敏感路径黑名单拦截（恶意 skill 防护，防凭据外泄） | `pi.on("tool_call"/"session_start"/"session_shutdown")` |
| `subagent-bash-guard.ts` | worker 无 UI bash 防线：硬拒绝或生成 capability request | `pi.registerTool("bash")`（仅 PI_SUBAGENT） |
| `gate.ts` | 启动时依赖检测；交互式 bash 审批已内聚到 `bash-guard.ts` | `pi.on("session_start")` |
| `llm-review.ts` | gate 的 LLM 预审层（命令质量/安全审核，safe 自动放行） | gate 内部调用 |
| `paths.ts` | 目录白/黑名单（GUI 动态维护，sandbox-paths.json） | gate/guard/allow 内部调用 |
| `allow.ts` | 一次性沙箱升权工具 `sandbox-allow`（含长期/session 目录授权） | `pi.registerTool("sandbox-allow")` |
| `yolo.ts` | `/yolo` 会话级沙箱墙开关（全部降零，仅当前 session） | `pi.registerCommand("yolo")` |
| `session-access.ts` | 当前 session 临时可写根与信任根（不落盘） | allow/bash/job 内部调用 |

`index.ts` 按 guard → gate → allow 顺序合成注册（guard 硬拦截先于 gate 审批）。

注意：subagent 子进程经 `lib/subagent-run.ts` 显式加载 `guard.ts` 与 `subagent-bash-guard.ts`，不加载 gate/allow。worker 默认 readonly；显式 worktree profile 只写 `sandbox_dir`。风险命令由 guard 写结构化 capability request，父进程复用现有 gate GUI/TUI 审批，批准后仅以绑定精确 command digest 的一次性 grant 重启该 worker。network grant 由 `scripts/network-block-run.c` 编译出的 seccomp runner 执行：未批准的 worker bash 无法创建 IPv4/IPv6 socket；Unix socket 保留。publish/read-secrets 不开放给 worker。

## 文件结构

```
sandbox-permissions/
├── index.ts             # 合成入口（方案 B：真融合）
├── guard.ts             # 敏感路径黑名单拦截
├── subagent-bash-guard.ts # worker 无 UI bash 覆盖 + capability request
├── guard.test.ts
├── yolo.ts              # /yolo 会话级沙箱墙开关（全部降零）
├── yolo.test.ts
├── gate.ts              # 危险命令审批（LLM 预审 + GUI 审计 + TUI 回退）
├── llm-review.ts        # LLM 预审层（调 LLM API 审核命令质量/安全）
├── llm-review.test.ts
├── review-system-prompt.txt  # 审核主体 system prompt（纯文本）
├── review-examples.txt       # 常见误判样本（容易误报的命令，独立存放）
├── review-pool.toml          # 审核模型池（个人依赖，gitignore）
├── paths.ts             # 目录白/黑名单（GUI 动态维护，sandbox-paths.json）
├── paths.test.ts
├── rule-engine.ts       # token 化规则引擎
├── rule-engine.test.ts
├── scanner.ts           # 命令分段/token 化
├── inline-script.ts     # 内联脚本提取与落盘
├── inline-script.test.ts
├── allow.ts             # sandbox-allow 升权工具
├── helpers.ts           # 升权 env/路径解析纯函数
├── helpers.test.ts
├── session-access.ts    # 当前 session 的临时可写根/信任根
├── session-access.test.ts
└── README.md
```

## 测试

```bash
node --experimental-strip-types extensions/sandbox-permissions/guard.test.ts
node --experimental-strip-types extensions/sandbox-permissions/rule-engine.test.ts
node --experimental-strip-types extensions/sandbox-permissions/inline-script.test.ts
node --experimental-strip-types extensions/sandbox-permissions/helpers.test.ts
node --experimental-strip-types extensions/sandbox-permissions/llm-review.test.ts
node --experimental-strip-types lib/subagent-capability.test.ts
node --experimental-strip-types lib/subagent-env.test.ts
```

network seccomp runner（Linux）构建：

```bash
cc -O2 -Wall -Wextra -o scripts/vendor/network-block-run scripts/network-block-run.c -lseccomp
chmod 755 scripts/vendor/network-block-run
```

runner 缺失时 worker 网络墙 fail-closed（退出码 125），不会裸跑。

## gate 规则引擎（原 permission-gate）

token 化规则引擎取代正则匹配；对 bash 动态构造（命令替换 / eval / 变量作命令等）降级为人工确认。

### 判定流程

```
bash 命令
  │
  ├─ 分段（&& | || ; 换行）→ 段内 token 化（去引号、env 前缀独立）
  │
  ├─ 规则匹配（命令名 + 子命令 + flag/参数精确匹配）
  │     │
  │     ├─ 无危险规则 ──────────────┐
  │     │                          │
  │     └─ 有危险规则 ── venv 白名单覆盖？── 是 ──┘
  │           │ 否                        │
  │           ▼                          ▼
  │     直接拦 / 弹窗确认           无动态构造 ──► 放行
  │                                        │
  │                                        含动态构造 ──► LLM 预审
  │
  ├─ LLM 预审（需确认命令）：
  │     ├─ verdict=safe 且 auto 模式 ──► 放行（不弹窗）
  │     ├─ verdict=risky/dangerous ──► 弹窗（附 LLM 意见）
  │     └─ 审核失败/超时/禁用 ──► 回退弹窗（绝不静默放行）
  │
  └─ 非交互模式 → 直接阻止（无 UI 无法确认）
```

### 规则结构

每条规则是结构化定义（rule-engine.ts 的 RULES）：

```ts
{
  name: "uv-system",            // 规则名（透传 GUI 展示与高亮）
  cmd: "uv",                    // 命令名（精确 token；数组 = 任一）
  subcmd: ["pip", "install"],   // 子命令序列（可选）
  anyFlags: ["--system"],       // 至少出现一个的 flag（精确 token）
  anyArgs: ["777"],             // 至少出现一个的参数（精确 token）
  tip: "...",                   // 展示文案
  autoReject: true,             // 自动拒绝（不弹窗）
}
```

内置规则：`sudo` / `rm` 递归 / `chmod|chown 777` / `uv --system` / 裸 `pip install` / `python -m pip install` / `npm|npx`（强制 pnpm）/ `tsx`（强制 node 原生跑 TS，含带路径调用）。命中时返回 `matched`（命中的 token 列表），供 GUI 高亮危险点。

### venv 白名单

venv 激活（`uv venv`、`source|x` 激活、`python -m venv`）之后的安装命令放行；`--system` 标志永不放行。

### 动态构造降级

`hasDynamicConstructs` 识别 bash 动态构造（命令替换 `$()`/反引号、`eval`、`bash -c`、反斜杠拼接命令名、变量作命令、ANSI-C 引号、别名/函数定义、进程替换）。命中时即使无危险规则也降级为人工确认——静态检测对动态构造不可靠，交给用户判断。`dynamicConstructTokens` 返回命中的特性 token，GUI 高亮动态点。

### 如何扩展

添加新规则：编辑 `rule-engine.ts` 的 RULES 数组，push 一个结构化定义，并在 `rule-engine.test.ts` 补行为断言（先写测试，TDD）。

### 判定示例

| 命令 | 判定 |
|------|------|
| `cd /tmp && rm -rf mbtest && mkdir mbtest` | ⚠️ LLM 预审 → 多为 safe 自动放行 |
| `uv pip install requests --system` | 🚫 自动拒绝 |
| `uv pip install requests` | ✅ 放行 |
| `uv venv && pip install requests` | ✅ 放行（venv 白名单） |
| `echo $(date)` | ⚠️ LLM 预审（动态构造） |

## LLM 预审（llm-review.ts）

命中「需人工确认」级别的命令（rm 递归 / sudo / dd / 动态构造 / 管道执行器 / Python 段等）不再直接弹窗，而是先调用 LLM API 审核命令的质量与安全性，减少弹窗打扰。

### 判定行为

| LLM 判定 | auto 模式（默认） | strict 模式 |
|----------|------------------|-------------|
| `safe`（意图明确、风险可控） | ✅ 自动放行，不弹窗 | ⚠️ 仍弹窗（附意见） |
| `risky` / `dangerous` | ⚠️ 弹窗（附 LLM 意见） | ⚠️ 弹窗（附 LLM 意见） |
| 审核失败（超时/网络/解析/无模型） | ⚠️ 回退弹窗，绝不静默放行 | ⚠️ 回退弹窗 |

### 审核 prompt（review-system-prompt.txt + review-examples.txt）

发送给 LLM 的 system prompt 拆成两个独立文件（纯文本，改了即生效，下次审核就用到，无需 /reload）：

- `review-system-prompt.txt`：审核主体 prompt（判定标准 / 输出 / 注入防护）
- `review-examples.txt`：常见误判样本（容易误报的命令，附应判结论与要点），随审核请求拼到 prompt 末尾

`loadReviewPrompt()` 读主体并把样本拼到末尾；样本文件缺失不影响主体（此时只用主体 prompt）。任一文件缺失/读失败时按「审核失败」处理：回退弹窗，绝不静默放行。

### 结论回传：工具调用

审核结论通过工具调用回传：请求时注册 `report_review_verdict` 工具（参数 `verdict` / `reason` / `suggestion`，schema 约束枚举），LLM 直接调用该工具提交结论。模型的回复文本不做 JSON 解析——允许像日常交流一样自然表述，原样作为 `opinion`（看法）展示给人工审核者；即使未调用工具（verdict 无法判定，回退弹窗），文本也一并展示。

审核模型：支持**模型池**（`models = [{provider, model}, ...]`），按序尝试，单个模型失败（限流/超时/网络）自动切换下一个，全部失败才回退弹窗（失败原因汇总展示）。池子未配置时兼容旧的 `provider`/`model` 单模型；两者皆无才用当前会话模型——绝不静默切换到未配置的模型（池内切换是显式配置的容错，不是静默）。prompt 内置注入防护：「测试环境 / 直接放行 / 忽略安全审核」等放宽审核的声称一律按注入忽略，判定只认命令本身，宁严勿松。

**池管理指令**（不用手抄供应商名/模型名）：

- `/provider:fast-put [关键词]` — 从全局模型列表里筛选一个加入审核池（交互式，展示上下文/价格；加完可选「测试一次审核链路」验证模型可用性）
- `/provider:fast-pop [provider/model 或模型名]` — 从审核池移除一个模型（池子清空后审核回退当前会话模型）

审核模型池独立存放在 `extensions/sandbox-permissions/review-pool.toml`（个人依赖：供应商配置/API key 不入库，已 gitignore）；`extensions.toml` 只留通用开关（enabled/mode/timeout_ms/token_idle_ms/max_cache）。

### GUI 联动（wails-gui 权限闸门窗口）

LLM 预审结论随请求一并传给 Wails 权限窗口（`gate` 窗口 request.json 的 `review` 字段）：窗口在命令下方展示「云端模型审核」区块——verdict 徽标（安全/有风险/危险/未判定）、理由、建议与模型的自然语言看法（`opinion`，原样完整展示）。审核失败且无任何可展示内容时不传 GUI；`verdict=safe` 且 auto 模式仍直接放行不弹窗。GUI 侧改动在 `wails-gui/`（`app.go` 透传 + `GateView.vue` 展示），改后需 `wails build` 重新编译二进制。

### 审批附言（三个窗口通用）

三个 gate 窗口（`audit` / `capability` / `sandbox-allow`）底部都有一条常驻附言输入框（`data-name=gate-comment-input`）：点「🚫 拒绝」或允许按钮时，框里有内容就随响应带上 `{ action, comment }`，空则不带（不发空 `comment` 字段）。输入框有内容时右侧出现 `✕` 清空按钮（等同 Esc）；`Ctrl/Cmd+Enter` = 允许。sandbox-allow 的目录授权动作也会带上当前附言。

「▾ 历史」展开 chip 面板（`gate-history-toggle`）：点 chip 文本回填到输入框（`gate-history-chip`），悬停 chip 显示 `✎` 原地编辑（`gate-history-edit`）与 `✕` 删除单条（`gate-history-delete`）；没有批量清空能力。历史读写走 `wails-gui/app.go` 的 `LoadReasons` / `SaveReason` / `UpdateReason` / `DeleteReason`，落盘仍是 `permission-gate-reasons.csv`（去重 + 上限 20 条）。

附言同时落地两处：

| 窗口 | 回传（模型能看到） | 审计条目 |
|------|-------------------|----------|
| `audit`（bash / bash_background） | 工具结果末尾追加 `[审批附言：…]` | `bash-audit` 条目的 `comment`（新增 `origin` 区分 `bash` / `bash_background`） |
| `capability`（subagent） | worker 的 bash 工具结果前加 `[主 agent 附言] …` | `subagent-capability-approval` 条目 |
| `sandbox-allow` | 工具结果末尾追加 `[审批附言：…]` | `sandbox-allow` 条目的 `comment` |

拒绝路径不变：`comment` 仍作为「拒绝理由」写进对应审计条目与拒绝文案。TUI 回退是二选一，不产生附言。

### 配置（extensions.toml 的 `[sandbox-llm-review]`）

扩展配置统一放 `~/.pi/agent/extensions.toml`（不进 settings.json，避免换模型时被误改）：

```toml
[sandbox-llm-review]
enabled = true          # 总开关；false = 回到纯规则弹窗流程
mode = "auto"           # auto=判安全直接放行；strict=仅给意见仍弹窗
# provider = "deepseek" # 可选：指定审核模型（缺省用当前会话模型）
# model = "deepseek-v4-flash"
timeout_ms = 30000      # 注册模型单次审核总时长兜底；超时回退弹窗
token_idle_ms = 4000    # 免费模型相邻 token 间隔上限；停滞超阈值判失败
max_cache = 200         # 内存缓存上限（同命令同规则不重复调 API）
```

### 安全底线

- **autoReject 规则永不进 LLM 层**：`rm -rf`、`sudo`、`dd` 直读设备等仍由规则引擎处理，gate.ts 先硬拦/确认，不因 LLM 判定放宽
- **失败即保守**：LLM 不可用（未配置模型 / 超时 / 网络错误 / 输出无法解析）一律回退原弹窗流程，绝不静默放行
- **无 UI 模式不变**：非交互模式（print/json）仍直接阻止，不进 LLM 预审
- **知情**：命令文本会发送到配置的 LLM API（默认当前会话模型）；启用即视为知情，介意可关 `enabled`
- 审核记录写入会话（`sandbox-llm-review` 条目，不进 LLM 上下文），可在 `/session` 查看

## /yolo：会话级沙箱墙开关（yolo.ts）

`/yolo` 把整面沙箱防护墙降到零（仅当前 session，默认关闭）。

```
/yolo         # 翻转开关
/yolo on      # 开启（全部降零）
/yolo off     # 恢复防护
/yolo status  # 查看当前状态
```

开启时关闭三层墙：

| 墙 | 关闭方式 |
|----|---------|
| bash 审批链（bash-guard） | 跳过 checkCommand / LLM 预审 / 人工确认，直接执行 |
| Landlock 写保护（sandbox-shell） | spawnHook 注入 `PI_SANDBOX_DISABLE=1` |
| read/write 黑名单（guard.ts） | 跳过敏感路径拦截 |

要点：

- 状态只存内存（`yolo.ts`），不开新 session、不写盘；新 session 自动复位为关闭
- 状态通过 status bar（key=`sandbox-yolo`）显示在 session 中：开启显示 `🚀 YOLO`，关闭清除
- 仅主进程生效：subagent 子进程经 `--extension` 单独加载 guard.ts，yolo 默认关闭，子进程保持防护

## 目录授权（paths.ts，GUI 动态维护）

gate 审核弹窗（危险命令 / sandbox-allow 升权）会展示候选目录（请求的 writePaths + 命令中提取的路径），每个候选目录可选择长期或当前 session 的授权级别：

| 名单/授权 | 效果 | 生效层 |
|------|------|--------|
| 长期信任 `allowDirs` | 普通 bash 常驻可写；sandbox-allow 的 write-paths 完全覆盖时可免审批；autoReject 仍优先 | shell/allow（即时生效） |
| 本 session 信任 | 当前 session 可写；后续 sandbox-allow 完全覆盖时可免审批 | session-access/allow（内存） |
| 本 session 可写 | 当前 session 可写；后续 sandbox-allow 仍需审批 | session-access/bash/job（内存） |
| 黑名单 `blockDirs` | 该目录整体视为敏感，read/write/bash 一旦引用直接拒绝 | guard.ts（session_start 加载，reload 生效） |

### 存储

`extensions/sandbox-permissions/sandbox-paths.json`（程序动态写入，与手写静态配置 extensions.toml 分离——JSON 写入不破坏 toml 注释）：

```json
{ "allowDirs": ["~/.pnpm", "~/.go"], "blockDirs": ["/home/user/secret"] }
```

`allowDirs` 是长期生效的**可写根 + sandbox-allow 信任根**：普通 bash 会把它们作为常驻 `--rw` 根；`sandbox-allow` 的 `write-paths` 请求若完全落在其中，可免重复审批。它不改变当前用户的系统身份，也不能绕过 `autoReject` 硬拒绝规则。

### Subagent 自动审核

worker 不弹自己的 UI。对明确、静态的开发期网络拉取命令，`subagent-bash-guard` 以本地规则自动批准并仅为该精确命令开启网络：包管理器的 `install/add/update/remove/ci`、`git clone/fetch/pull/submodule add|update`，以及不写文件、不上传、非管道执行的 `curl`/`wget`。这减少依赖安装和只读拉取的重复弹窗。

以下情况**不会**自动批准，仍按 capability request 交给父会话人工审核或直接拒绝：`git push`、包发布、上传/POST、下载后执行（如 `curl | sh`）、重定向、命令替换/变量等动态 shell 构造，以及任何命中危险命令规则的操作。worker 自动审核不调用 LLM：子进程环境不携带审核模型凭据；未知网络命令 fail-closed 回退人工审核。

当前 session 的目录授权只存在内存，不写入上述文件：

- **本 session 可写**：后续普通 bash 可写该目录，但 `sandbox-allow` 仍需审批
- **本 session 信任**：后续普通 bash 可写该目录，且匹配的 `sandbox-allow` 可免审批
- 两者都只在当前 session 有效；切换、恢复、分叉或退出后不继承

### 长期根的命令豁免规则（paths.ts `isWhitelisted`）

- 命令**所有**目标路径都在长期 `allowDirs` 内才可免后续 sandbox-allow 审批；任一目标在长期根外 → 照常审核
- 长期根只减少重复审批，不绕过 `autoReject` 硬拒绝规则
- 含动态构造（`$()` / 变量引用 `$dir` 等）→ 不豁免（路径无法静态确认，避免 `cd /tmp/build && rm -rf $dir` 误放行）
- 提取不到目标路径 → 不豁免；autoReject 硬拦优先于白名单（白名单不豁免 autoReject）

### GUI 交互

GateView.vue 的「📁 目录授权」区块提供四种动作：

- 「长期信任」→ 写入 `allowDirs`，当前命令放行
- 「本 session 信任」→ 写入当前内存信任根，当前命令放行
- 「本 session 可写」→ 写入当前内存可写根，当前命令放行
- 「黑名单」→ 写入 `blockDirs`，当前命令拒绝

返回 `pathActions: [{ path, list }]`，allow 收到后只接受本次窗口展示过的候选路径，再应用授权。

### sandbox-allow 使用语义

`sandbox-allow` 只在普通 bash 确实因为沙箱写保护无法完成时使用。它执行的是一整条 shell 命令字符串；`&&`、`;`、管道、重定向和子 shell 都包含在同一次审批与同一个 timeout 内。

- `permission=write-paths`：保留文件系统沙箱，只额外开放 `paths` 中的最小可写根；`paths` 必填，根目录 `/` 禁止
- `permission=full-access`：本次命令完全取消文件系统沙箱，可以读写当前用户原本有权限访问的任意路径；它不是“多开放一个目录”，也不提升为 root
- `justification`：非空理由会展示给审批者
- `timeout`：用户批准后整条命令链的最长执行时间（秒），不限制用户查看审批窗口的时间
- `memoryMb`：可选正整数（MB），设置该命令进程树的内存上限；缺省 `sandbox-shell` 按默认 1GiB 执行。**需要超过默认 1GiB 的命令必须由模型给出具体 MB 数值**（上限 `MAX_MEMORY_MB=32768`，更大拒绝）。数值会随审批标题展示给用户，并经用户同意后注入 `PI_SANDBOX_MEMORY_MB`。

## 内存限制（内存墙）

所有 bash 命令默认有 **1GiB 内存上限**，与文件系统沙箱（Landlock 写保护）**正交**——同一命令同时受两层约束，互不替代。

- **实现**：`scripts/sandbox-shell.mjs` 对命令进程树采样匿名内存（`/proc/<pid>/status` 的 `RssAnon`），超过上限则以 `SIGKILL` 终止整棵进程组，退出码 `137`（128+9）。选用 `RssAnon` 而非 `VmRSS`，是为了避免多进程构建（如 `make -j`）里共享库被逐进程重复计数导致的误杀。
- **提升**：普通 bash 固定 1GiB；需要更大内存时**必须**走 `sandbox-allow` 并显式指定 `memoryMb`（具体 MB 数值，上限 32768），经审批后该命令按指定上限执行。
- **关闭**：`/yolo` 全降零时由 `bash-guard` 的 `spawnHook` 注入 `PI_SANDBOX_MEMORY_DISABLE=1`，内存墙一并关闭。普通 `sandbox-allow` 的 `full-access` 只取消文件系统沙箱，**不**关闭内存墙（仍按 1GiB 默认或 `memoryMb` 指定值执行）。
- **通道覆盖**：内建 bash、`sandbox-allow`、`bash_background`（dsh-jobs）都经 `sandbox-shell.mjs`，缺省均为 1GiB；后台任务可通过 `SandboxedCommandOptions.memoryMb`（`lib/sandboxed-command.ts`）单独指定。
- **前置审批**：`bash_background` 与内建 bash 共用 `lib/bash-approval.ts` 的审批链——黑名单/内联脚本/全 autoReject 硬拒；需确认类先 LLM 预审，`safe`+auto 直接启动，否则弹 GUI/TUI 人工（批准在 `registry.start` 之前完成，等待发生在本次工具调用内）。审批条目写入 `bash-audit` 并带 `origin: "bash_background"`。
- **局限**：内存墙依赖 `/proc`，仅 Linux 生效；macOS/Windows 无 `/proc` 时采样恒为 0，内存墙自动失效（不误杀、不报错）。

GUI 中的目录动作会同时批准当前命令：

- **长期信任**：写入 `allowDirs`，跨 session 可写并可免后续 `sandbox-allow` 审批
- **本 session 信任**：当前 session 可写并可免后续 `sandbox-allow` 审批
- **本 session 可写**：当前 session 可写，但后续 `sandbox-allow` 仍需审批
- **黑名单**：写入 `blockDirs`，后续敏感路径拦截

长期根、session 根和本次 `paths` 都会在执行前合并；GUI 响应中的路径只接受本次窗口展示过的候选目录。

### 生效与同步

- 长期 `allowDirs`：shell 每次启动读取，普通 bash 与 `sandbox-allow` 实时生效；它们同时承担可写根与长期信任根
- session 可写/信任根：当前进程内存状态，按 session ID 隔离，不跨 session、不落盘
- 黑名单：guard 在 session_start 加载（reload 随扩展重载重新触发），添加后需 `/reload`
- `sandbox-paths.json` 进 git 同步（与多机配置一致）
