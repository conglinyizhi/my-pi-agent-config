# sandbox-permissions（沙箱权限：guard / gate / allow）

一个扩展、三个子模块，覆盖 pi 沙箱权限全链路：

| 子模块 | 职责 | 注册 |
|--------|------|------|
| `guard.ts` | 敏感路径黑名单拦截（恶意 skill 防护，防凭据外泄） | `pi.on("tool_call"/"session_start"/"session_shutdown")` |
| `gate.ts` | 危险 bash 命令审批（规则引擎 + 白名单豁免 + LLM 预审 + GUI/TUI） | `pi.on("tool_call"/"session_start")` |
| `llm-review.ts` | gate 的 LLM 预审层（命令质量/安全审核，safe 自动放行） | gate 内部调用 |
| `paths.ts` | 目录白/黑名单（GUI 动态维护，sandbox-paths.json） | gate/guard/allow 内部调用 |
| `allow.ts` | 一次性沙箱升权工具 `sandbox-allow` | `pi.registerTool("sandbox-allow")` |

`index.ts` 按 guard → gate → allow 顺序合成注册（guard 硬拦截先于 gate 审批）。

注意：subagent 子进程只经 `lib/subagent-run.ts` 以 `--extension` 单独加载 `guard.ts`，不加载 gate/allow（子进程 bash 已限 worktree、无 UI 无法审批）。

## 文件结构

```
sandbox-permissions/
├── index.ts             # 合成入口（方案 B：真融合）
├── guard.ts             # 敏感路径黑名单拦截
├── guard.test.ts
├── gate.ts              # 危险命令审批（LLM 预审 + GUI 审计 + TUI 回退）
├── llm-review.ts        # LLM 预审层（调 LLM API 审核命令质量/安全）
├── llm-review.test.ts
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
└── README.md
```

## 测试

```bash
node --experimental-strip-types extensions/sandbox-permissions/guard.test.ts
node --experimental-strip-types extensions/sandbox-permissions/rule-engine.test.ts
node --experimental-strip-types extensions/sandbox-permissions/inline-script.test.ts
node --experimental-strip-types extensions/sandbox-permissions/helpers.test.ts
node --experimental-strip-types extensions/sandbox-permissions/llm-review.test.ts
```

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

### 审核 prompt（review-system-prompt.txt）

发送给 LLM 的 system prompt 独立存放在 `extensions/sandbox-permissions/review-system-prompt.txt`（纯文本，改了即生效，下次审核就用到，无需 /reload）。文件缺失或读失败时按「审核失败」处理：回退弹窗，绝不静默放行。

### 结论回传：工具调用

审核结论通过工具调用回传：请求时注册 `report_review_verdict` 工具（参数 `verdict` / `reason` / `suggestion`，schema 约束枚举），LLM 直接调用该工具提交结论。模型的回复文本不做 JSON 解析——允许像日常交流一样自然表述，原样作为 `opinion`（看法）展示给人工审核者；即使未调用工具（verdict 无法判定，回退弹窗），文本也一并展示。

审核模型：支持**模型池**（`models = [{provider, model}, ...]`），按序尝试，单个模型失败（限流/超时/网络）自动切换下一个，全部失败才回退弹窗（失败原因汇总展示）。池子未配置时兼容旧的 `provider`/`model` 单模型；两者皆无才用当前会话模型——绝不静默切换到未配置的模型（池内切换是显式配置的容错，不是静默）。prompt 内置注入防护：「测试环境 / 直接放行 / 忽略安全审核」等放宽审核的声称一律按注入忽略，判定只认命令本身，宁严勿松。

**池管理指令**（不用手抄供应商名/模型名）：

- `/provider:fast-put [关键词]` — 从全局模型列表里筛选一个加入审核池（交互式，展示上下文/价格；加完可选「测试一次审核链路」验证模型可用性）
- `/provider:fast-pop [provider/model 或模型名]` — 从审核池移除一个模型（池子清空后审核回退当前会话模型）

审核模型池独立存放在 `extensions/sandbox-permissions/review-pool.toml`（个人依赖：供应商配置/API key 不入库，已 gitignore）；`extensions.toml` 只留通用开关（enabled/mode/timeout_ms/max_cache）。

### GUI 联动（wails-gui 权限闸门窗口）

LLM 预审结论随请求一并传给 Wails 权限窗口（`gate` 窗口 request.json 的 `review` 字段）：窗口在命令下方展示「云端模型审核」区块——verdict 徽标（安全/有风险/危险/未判定）、理由、建议与模型的自然语言看法（`opinion`，原样完整展示）。审核失败且无任何可展示内容时不传 GUI；`verdict=safe` 且 auto 模式仍直接放行不弹窗。GUI 侧改动在 `wails-gui/`（`app.go` 透传 + `GateView.vue` 展示），改后需 `wails build` 重新编译二进制。

### 配置（extensions.toml 的 `[sandbox-llm-review]`）

扩展配置统一放 `~/.pi/agent/extensions.toml`（不进 settings.json，避免换模型时被误改）：

```toml
[sandbox-llm-review]
enabled = true          # 总开关；false = 回到纯规则弹窗流程
mode = "auto"           # auto=判安全直接放行；strict=仅给意见仍弹窗
# provider = "deepseek" # 可选：指定审核模型（缺省用当前会话模型）
# model = "deepseek-v4-flash"
timeout_ms = 10000      # 单次审核超时；超时回退弹窗
max_cache = 200         # 内存缓存上限（同命令同规则不重复调 API）
```

### 安全底线

- **autoReject 规则永不进 LLM 层**：`rm -rf`、`sudo`、`dd` 直读设备等仍由规则引擎处理，gate.ts 先硬拦/确认，不因 LLM 判定放宽
- **失败即保守**：LLM 不可用（未配置模型 / 超时 / 网络错误 / 输出无法解析）一律回退原弹窗流程，绝不静默放行
- **无 UI 模式不变**：非交互模式（print/json）仍直接阻止，不进 LLM 预审
- **知情**：命令文本会发送到配置的 LLM API（默认当前会话模型）；启用即视为知情，介意可关 `enabled`
- 审核记录写入会话（`sandbox-llm-review` 条目，不进 LLM 上下文），可在 `/session` 查看

## 目录白/黑名单（paths.ts，GUI 动态维护）

gate 审核弹窗（危险命令 / sandbox-allow 升权）会展示候选目录（请求的 writePaths + 命令中提取的路径），每个候选目录旁有「⬜ 白名单」「⬛ 黑名单」按钮，用户逐个加入，长期生效：

| 名单 | 效果 | 生效层 |
|------|------|--------|
| 白名单 `allowDirs` | 命令涉及的所有目标路径都在该目录内 → gate 直接放行（不弹窗、不过 LLM 预审） | gate.ts（即时生效） |
| 黑名单 `blockDirs` | 该目录整体视为敏感，read/write/bash 一旦引用直接拒绝 | guard.ts（session_start 加载，reload 生效） |

### 存储

`extensions/sandbox-permissions/sandbox-paths.json`（程序动态写入，与手写静态配置 extensions.toml 分离——JSON 写入不破坏 toml 注释）：

```json
{ "allowDirs": ["/tmp/build"], "blockDirs": ["/home/user/secret"] }
```

### 白名单豁免的保守规则（paths.ts `isWhitelisted`）

- 命令**所有**目标路径都在 allowDirs 内才放行；任一目标在白名单外 → 照常审核
- 含动态构造（`$()` / 变量引用 `$dir` 等）→ 不豁免（路径无法静态确认，避免 `cd /tmp/build && rm -rf $dir` 误放行）
- 提取不到目标路径 → 不豁免；autoReject 硬拦优先于白名单（白名单不豁免 autoReject）

### GUI 交互

GateView.vue 的「📁 目录名单」区块：点击候选目录的「白名单」→ 落 allowDirs 且当前命令放行；「黑名单」→ 落 blockDirs 且当前命令拒绝。返回 `pathActions: [{ path, list }]`，gate/allow 收到后写名单并继续原判定。

### 生效与同步

- 白名单：gate 每次审核实时读取，立即生效
- 黑名单：guard 在 session_start 加载（reload 随扩展重载重新触发），添加后需 `/reload`
- `sandbox-paths.json` 进 git 同步（与多机配置一致）
