# thinking-fold

把 thinking 块内**所有合格的复读段**折成一行提示，段与段之间的内容原样保留；只改 TUI
显示，不碰会话内容。

## 起因

便宜模型（本例 `tokenflux/deepseek-flash`）在超长会话里，thinking 会退化成复读：

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

模型经常复读一段后自己恢复、继续写正事，复读段因此落在**块中间**。只认「尾部后缀」
会整段漏掉。本机会话实测（`sessions/--tmp-tmp.cAgoveK0on--/2026-09-27T02-37-46-241Z_…jsonl`，
376 个 thinking 块）：

```
#228  06:17:24  块 4883 字符
      复读段 原始行 131-688，239 行 / 891 字，段后还有 55 行正常内容
      好。 ×139 / 跑。 ×69
```

老版本折不到它 —— 这正是改成「块内所有合格复读段」的理由。

## 做什么

注册一个 `registerMarkdownTransformer`，只对 `messageType === "assistant-thinking"`
生效：找出块内所有合格的复读段，每段换成一行提示，提示就落在被折掉的位置上。

```
⋯ [已折叠 236 行重复输出：好。 ×81 / 执行。 ×39 / Output. ×11]
（中间这段是正文，原样保留）
⋯ [已折叠 239 行重复输出：好。 ×139 / 跑。 ×69]
（段后的正文也照留）
```

纯渲染层：

- 不改会话内容、不改发给模型的内容（thinking 原文照旧入库、照旧进上下文）
- 不发消息、不 `appendEntry`、不写文件、transformer 里没有任何 IO
- transformer 整体 try/catch，异常时原样返回；关闭状态直接原样返回，零副作用

## 怎么判

纯逻辑在 `detector.ts`，与 `loop-guard` 共用行归一化（`normalizeLine` / `hasSubstance`），
避免两套口径漂移。`findDupSegments()` 返回块内所有命中段（按块内顺序），`applyFold()`
负责按段拼接。

1. 逐行归一化，只保留「非空 + 有实义字符」的行，并记住原始行号
2. 整块统计每行出现次数：出现 ≥ `minCount` 次且长度 ≤ `maxLineLen` 的行算「复读行」；
   整块最常见行出现次数 < `maxTopCount` → 直接放过
3. 复读行聚成**区间**：区间内允许夹 ≤ `gapMax` 个连续非复读行（循环里夹的变化词），
   夹不下就断开，下一段从下一个复读行重新起头
4. 每个区间套规模 / 密度判据：`minLines` / `minChars` / `maxKinds` / `minDensity`
5. 区间两端对齐到复读行（起于第一个、止于最后一个），段外的正常内容一行不吞；
   段与段之间的内容由 `applyFold()` 原样保留

两道兜底（都是把老版本的行为接回来，不是放宽判据）：

- **稀头密尾**：区间整段密度不够时，在区间内找最长合格后缀（老版本从尾往前扫就是这个
  语义）；对称地也找一次最长合格前缀
- **两截都太小**：相邻区间各自都够不着 `minLines` / `minChars`、但合并后过全部判据时
  合并成一截 —— 密度那条会把大段正文挡在外面，所以合并不等于放纵

| 参数 | 含义 | 默认 |
|---|---|---|
| `minCount` | 一行至少出现几次才算复读行 | 3 |
| `maxLineLen` | 复读行长度上限 | 20 |
| `minDensity` | 段内复读字符占比下限 | 0.75 |
| `minChars` | 折叠段字符下限 | 600 |
| `minLines` | 折叠段行数下限 | 40 |
| `maxKinds` | 折叠段内复读行种类上限 | 20 |
| `maxTopCount` | 整块最常见行至少出现次数 | 5 |
| `gapMax` | 段内允许夹的连续非复读行数 | 2 |

## 误伤与取舍（重要）

判据不变，变的是「只认尾巴」改成「按区间逐段认」。对齐是两道闸里的关键一道：段起于
第一个复读行、止于最后一个复读行，宁可少折，也不把段外的正文吞掉。

本机语料回归（同一份快照，376 个 thinking 块 / 906,278 字符，探针口径）：

| 版本 | 命中块 | 折掉的字符 | 段内非复读长行 | 全块唯一的代码/清单行 | 整段折光 |
|---|---|---|---|---|---|
| 尾部后缀（旧） | 44 | 182,640（20.2%） | 9,230 字符（6.7%） | 180 行 | 1 / 44 |
| **块内分段（当前）** | **45** | 171,066（18.9%） | 1,271 字符（1.0%） | 2 行 | 0 / 45 |

- 命中块 +1：多折的就是上面那个 239 行 / 891 字的中段（老版本完全看不见它）
- 折叠字符 -11,574：新版本命中 45 段（尾段 42 / 中段 3）。两块都命中的块里，新版留在
  屏幕上的是 12,943 字符**正文**（老版本从早期一个孤立复读行一路折到块尾，中间那些推理
  一起被吞了）；新多折进去 1,369 字符（就是中段那截）。净效果是少折了一点、折得准了
- 误伤指标全面下降：段内非复读长行 6.7% → 1.0%，全块唯一的代码 / 清单行 180 → 2 行，
  「整段折光（一行正文不留）」1 → 0 次

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

命中时**不写状态栏**。状态栏是各扩展共用的地皮，折叠是高频小事，不该占一格：想看折叠统计就走 `/thinking-fold status`。

## 实现

- `detector.ts` — 纯逻辑 `findDupSegments()`：归一化 → 复读行 → 区间切段 → 逐段判据，
  区间内统计一次扫完；`push()` 负责两端对齐，`scan()` 负责兜底与递归
- `index.ts` — pi 接线：transformer 注册、`applyFold()` 按段拼接（段间内容逐行原样搬）、
  配置读取、命令、快捷键；对同一段 markdown 做了 memo，避免滚动 / footer 刷新
  时重复扫描
- `detector.test.ts` / `index.test.ts` — 单元与接线测试（假 pi 驱动真实 handler）
- `scripts/thinking-fold-probe.ts` — 回归探针，读历史 jsonl 报命中块数 / 段数（尾段与中段）/ 
  折叠字符 / 误伤分布，只读

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
