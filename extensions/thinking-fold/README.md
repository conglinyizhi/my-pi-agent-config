# thinking-fold

把 thinking 块**尾部**的重复输出折成一行提示，只改 TUI 显示，不碰会话内容。

## 起因

便宜模型（本例 `tokenflux/deepseek-flash`）在超长会话里，thinking 尾部会退化成复读：

```
好。
执行。
好。
执行。
（行动）
好。
…（几十上百次）
```

模型自己还能继续出 toolCall、任务照常推进，所以**不该中止生成**（那是 `loop-guard`
的活，它管整块上万字符的失控）。但屏幕上这一段会把上下文顶走，看着像卡死。

实测本机会话 `2026-09-27T02-16-03-966Z_…jsonl`：203 个 thinking 块里命中 83 块
（40.9%），最早命中在第 111 块；折叠后从显示里移除 68,382 字符（按归一化行长计，
约为该会话 thinking 总量的 10%）。把 `sessions/--home-clyzhi--/` 下 40 个会话一起跑：
1,110 块命中同样这 83 块，命中全部集中在上面那一个会话里。

## 做什么

注册一个 `registerMarkdownTransformer`，只对 `messageType === "assistant-thinking"`
生效：检测尾部复读后缀，命中就把后缀换成一行提示。

```
⋯ [已折叠 236 行重复输出：好。 ×81 / 执行。 ×39 / Output. ×11]
```

纯渲染层：

- 不改会话内容、不改发给模型的内容（thinking 原文照旧入库、照旧进上下文）
- 不发消息、不 `appendEntry`、不写文件、transformer 里没有任何 IO
- transformer 整体 try/catch，异常时原样返回；关闭状态直接原样返回，零副作用

## 怎么判

纯逻辑在 `detector.ts`，与 `loop-guard` 共用行归一化（`normalizeLine` / `hasSubstance`），
避免两套口径漂移。

1. 逐行归一化，只保留「非空 + 有实义字符」的行，并记住原始行号
2. 整块统计每行出现次数：出现 ≥ `minCount` 次且长度 ≤ `maxLineLen` 的行算「复读行」；
   整块最常见行出现次数 < `maxTopCount` → 直接放过
3. 从尾部往前扩展窗口，增量维护复读字符数 / 窗口字符数 / 复读行种类
4. 窗口满足全部条件即候选（`minLines` / `minChars` / `minDensity` / `maxKinds`），
   取**字符最多的候选**（最长合格后缀）
5. 起点对齐到窗口内第一个复读行（见下面「误伤与取舍」）

| 参数 | 含义 | 默认 |
|---|---|---|
| `minCount` | 一行至少出现几次才算复读行 | 3 |
| `maxLineLen` | 复读行长度上限 | 20 |
| `minDensity` | 窗口内复读字符占比下限 | 0.75 |
| `minChars` | 折叠段字符下限 | 600 |
| `minLines` | 折叠段行数下限 | 40 |
| `maxKinds` | 折叠段内复读行种类上限 | 20 |
| `maxTopCount` | 整块最常见行至少出现次数 | 5 |

## 误伤与取舍（重要）

「最长合格后缀」这个定义本身就会往前吃：窗口越长，越容易把复读段前头的正常内容
一起圈进来。所以判据里有两道闸：

- `minDensity`：窗口内**复读字符**占窗口字符的比例（默认 0.75）
- **起点对齐**：窗口定下来后，把起点往后推到窗口内第一个复读行。宁可少折，
  也不让开头那几行正常内容被吞

本机语料回归（目标会话 203 块，同一口径）：

| 配置 | 命中块 | 折掉的字符 | 折叠段内被折的长行 | 整段折光（一行不留） |
|---|---|---|---|---|
| 行占比 0.5（早期版本） | 96 | 191,438（29.1%） | 100,094 字符（52.3%） | 89 / 96 |
| **字符占比 0.75 + 起点对齐（当前默认）** | 83 | 68,382（10.4%） | 6,153 字符（9.0%） | 0 / 83 |
| 字符占比 0.8 | 47 | 39,036（5.9%） | 2,954 字符（7.6%） | 3 / 47 |

当前默认档折起来的内容里 91.2% 是复读行，剩下那部分主要是循环里夹的变化词
（`Output now.` / `FINAL.` / `Break loop.` 这类，不算信息），也有少量真的代码 / 清单行
（本机语料里 22 行）。想更保守就调 `minDensity = 0.8`，代价是命中块从 83 降到 47。

丢的只是显示：会话文件与模型上下文里的 thinking 原文一个字都没动；随时可以
`Ctrl+Shift+D`（或 `/thinking-fold off`）关掉折叠看原文。

## 配置

`extensions.toml`：

```toml
[thinking-fold]
enabled = true

# 判定阈值，键名见 detector.ts 的 DupOptions / DEFAULT_DUP_OPTIONS
[thinking-fold.detector]
# minDensity = 0.8   # 误伤敏感就调这个，见 README「误伤与取舍」
```

## 命令

- `/thinking-fold`（或 `/thinking-fold status`）查看状态：开关、本 session 折叠次数、当前阈值、最近一次折叠
- `/thinking-fold on` / `/thinking-fold off` 本 session 临时开关
- `Ctrl+Shift+D` 一键切换（与已有扩展的快捷键不冲突）

命中时状态栏短暂显示 `✂️ 折叠 N 行 / M 字`；关闭时清空。

## 实现

- `detector.ts` — 纯逻辑 `findDupSuffix()`，O(n)，窗口统计全增量维护
- `index.ts` — pi 接线：transformer 注册与折叠替换、配置读取、命令、快捷键、
  状态栏；对同一段 markdown 做了 memo，避免滚动 / footer 刷新时重复扫描
- `detector.test.ts` / `index.test.ts` — 单元与接线测试（假 pi 驱动真实 handler）
- `scripts/thinking-fold-probe.ts` — 回归探针，读历史 jsonl 报命中率 / 折叠占比 / 误伤分布，只读

```bash
node --test --experimental-strip-types extensions/thinking-fold/detector.test.ts extensions/thinking-fold/index.test.ts

# 回归：目录按大小取前 6 个 jsonl
node --experimental-strip-types scripts/thinking-fold-probe.ts \
  sessions/--home-clyzhi--/ --limit 6 --samples 8

# 想试更保守的阈值
node --experimental-strip-types scripts/thinking-fold-probe.ts \
  sessions/--home-clyzhi--/2026-09-27T02-16-03-966Z_01a0e0a5-e67e-71b5-a53f-aa8a63178f2b.jsonl \
  --min-density 0.8
```

## 刻意不做

- **不碰会话 / 不注入消息 / 不动系统提示词**：纯渲染层，KV 缓存前缀不受影响
- **不中止生成**：模型还在正常出 toolCall 的块就该让它跑完，中止是 loop-guard 的职责
- **fold 结果不可在 TUI 内展开**：要看原文就 `Ctrl+Shift+D` 关掉折叠（或 `off`）
- **不做正文（`assistant`）折叠**：正文里重复是 loop-guard 的领域；本扩展只盯 thinking
