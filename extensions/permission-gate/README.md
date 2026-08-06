# 权限闸门（Permission Gate）

在执行潜在危险的 bash 命令前请求用户确认。规则引擎采用「分段 + token 化」的结构化判断取代正则匹配；对 bash 动态构造（命令替换 / eval / 变量作命令等）降级为人工确认。

## 文件结构

```
permission-gate/
├── index.ts             # 主入口：审批流程（放行 / 自动拒绝 / GUI / TUI 降级）
├── rule-engine.ts       # token 化规则引擎：分段、规则匹配、venv 白名单、动态构造检测
├── rule-engine.test.ts  # 行为测试（当前 230 用例）
└── README.md
```

运行测试：`node --experimental-strip-types extensions/permission-gate/rule-engine.test.ts`

## 判定流程

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
  │                                        含动态构造 ──► 人工确认
  │
  └─ 非交互模式 → 直接阻止（无 UI 无法确认）
```

## 规则结构

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

## venv 白名单

venv 激活（`uv venv`、`source|x` 激活、`python -m venv`）之后的安装命令放行；`--system` 标志永不放行。

## 动态构造降级

`hasDynamicConstructs` 识别 bash 动态构造（命令替换 `$()`/反引号、`eval`、`bash -c`、反斜杠拼接命令名、变量作命令、ANSI-C 引号、别名/函数定义、进程替换）。命中时即使无危险规则也降级为人工确认——静态检测对动态构造不可靠，交给用户判断。`dynamicConstructTokens` 返回命中的特性 token，GUI 高亮动态点。

## 如何扩展

添加新规则：编辑 `rule-engine.ts` 的 RULES 数组，push 一个结构化定义，并在 `rule-engine.test.ts` 补行为断言（先写测试，TDD）。

## 判定示例

| 命令 | 判定 |
|------|------|
| `cd /tmp && rm -rf mbtest && mkdir mbtest` | ⚠️ 确认（rm 递归） |
| `uv pip install requests --system` | 🚫 自动拒绝 |
| `uv pip install requests` | ✅ 放行 |
| `uv venv && pip install requests` | ✅ 放行（venv 白名单） |
| `echo $(date)` | ⚠️ 确认（动态构造） |
