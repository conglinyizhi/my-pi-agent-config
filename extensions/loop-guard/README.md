# loop-guard

拦截「重复输出」型死循环：模型在 CoT 或正文里反复吐同一批占位短句，直到撞上 token 上限。

## 起因

一次长会话（2026-09）里，模型在思考区滑进停滞态，反复输出
`好。` / `做。` / `（输出）` / `（现在）` 这几句，单块最长的重复段达
13 万字符 / 2.8 万行，并且不是一次性的 —— 同一会话里出现了三处，
另外几百个历史会话里也有同款。它的代价很直接：烧 token、把上下文挤爆、
把「正在干活」的时间耗在空转上，而在流式阶段其实一眼就能看出来。

## 做什么

在流式阶段盯 thinking 与正文的增量（每一块独立判定），命中后分两档：

- **warn**：状态栏 + 一条提示，不动输出
- **abort**：中止本次生成，等 agent 停歇后注入一条纠正消息
  （`<loop_guard>`，带判据数字与改法），让模型带着指令继续干活

## 怎么判

形态是「字母表极小 + 行很短 + 没有新内容」，所以判据是：

| 判据 | 含义 | 默认 |
|---|---|---|
| 重复量 | 窗口内落在重复字母表里的字符数 | ≥ 2500 提示，≥ 9000 中止 |
| 平均行长 | 重复行的平均长度 | ≤ 20 |
| 长行占比 | 重复行里超过 32 字符的比例 | ≤ 0.2 |
| 新行占比 | 窗口内不属于重复字母表的行占比 | ≤ 0.3 |
| 字母表 | 重复字母表的大小 | ≤ 10 |
| 有内容 | 主导重复行必须含实义字符 | 纯符号行不算 |

「平均行长」与「新行占比」是两个互相独立的把关：停滞标记都是短句，
而日志回显要么整行长，要么每隔几行就冒出一条新内容。两个判据任一不满足就放过。

## 校准依据

拿本机 408 个历史会话、13.3 万个 assistant 输出块离线回放（把每块按
delta 粒度重放进检测器），结论：

- **命中 7 个块，逐条人工核对全部是真停滞循环，零误伤**
- 真循环的平均行长落在 2.4 ~ 12.3 字符；语料里最先出现的误伤样本是
  19.5（CI 矩阵日志）与 25 以上（shell 报错刷屏、tar 刷屏、50KB 单行回显），
  中间有很宽的空隙
- 消融实验：**精度几乎全靠「平均行长」**（放开它立刻引入 7 类误伤）；
  「新行占比」主要决定触发早晚；「字母表」是廉价兜底

真机回归（正式阈值，走 RPC 模式跑真实会话）：

| 输入 | 结果 |
|---|---|
| 300 行各不相同的数据 | 不触发 |
| 200 条同款 tar 警告回显（6367 字符重复，行长 31） | 不触发 |
| 同一句占位话重复 5000 行 | 2670 字预警 → 9078 字中止 → 注入纠正 → 新回合继续 |

## 刻意不做

- **不盯 `toolcall_delta`**：拦在工具调用 JSON 中间会毁掉这一轮
- **不注入系统提示词、不动工具表**：保 KV 缓存前缀稳定
- **warn 档不注入消息**：注入本身就是对正常输出的干扰
- **不追长句停滞**：同一句 40 字长话重复到极大跨度只做 warn 提示
  （判据见 `longStall*`），不进中止路径 —— 这类形态与日志回显太像，不值得冒险

已知不覆盖：

- 重复量在 2500 字符以下的小循环（会自然结束，代价可接受）
- `toolcall_delta` 里的重复（工具调用参数不盯）
- 平均行长超过 20 的形态：只做 warn 提示，不进中止路径
- 「实义字符」少于 3 个的行的重复（`{"a":1},`、`0,`、`}` 这类）：
  被 `hasSubstance` 直接忽略，因为正常 fixture / 代码里它们天然重复。
  代价是模型真在这类行上空转时抓不到 —— 拿误伤率换来的，接受

## 配置

`extensions.toml`：

```toml
[loop-guard]
enabled = true
mode = "abort"              # off | warn | abort
maxActionsPerSession = 3    # 每个 session 的中止次数上限
cooldownMs = 15000          # 两次中止之间的最小间隔

# 判据阈值，键名见 detector.ts 的 LoopGuardOptions / DEFAULT_OPTIONS
[loop-guard.detector]
# warnRepeatChars = 2500
# abortRepeatChars = 9000
# maxAvgLineChars = 20
```

## 命令

- `/loop-guard` 查看状态（模式、预算、判据、最近一次命中）
- `/loop-guard off|warn|abort` 本 session 临时切换模式
- `/loop-guard reset` 重置本 session 的中止预算

## 实现

- `detector.ts` — 纯逻辑状态机，不依赖 pi API：归一化行 → 取尾部字母表 →
  算重复窗口统计 → 判级别。行缓冲按行数/字符数双上限滚动，检查按字符数节流
- `index.ts` — pi 接线：`message_update` 喂增量（按 `contentIndex` 分块）、
  命中后通知/中止、`agent_settled` 注入纠正消息、`/loop-guard` 命令
- `detector.test.ts` / `index.test.ts` — 单元与接线测试（假 pi 驱动真实 handler）
- `scripts/loop-guard-calibrate.mjs` — 拿一批历史会话回归阈值，动阈值前先跑这个

```bash
node --test --experimental-strip-types extensions/loop-guard/detector.test.ts extensions/loop-guard/index.test.ts
node --experimental-strip-types scripts/loop-guard-calibrate.mjs ~/.pi/agent/sessions
```

`loop-guard-calibrate.mjs` 会把每个输出块按 delta 粒度重放进检测器（模拟真实流式），
列出命中项与最强近失，人眼核对命中是否都是真循环。改阈值后命中集合不应变大；
变大就说明精度在丢。

安全闸门：一个块只中止一次；每次中止叠 `cooldownMs` 冷却与
`maxActionsPerSession` 预算；预算耗尽后退回只提示。

一点已知差异：`pi.sendMessage(..., { triggerTurn: true })` 在 **print / json 模式
不产生新回合**（已单独探针验证，与中止无关）。subagent 恰好跑在这两种模式下，
所以那里是「中止 + 提示」生效、纠正消息只入队不自动续行。
代价可控：中止本身就止住了烧 token，后续回合由上级流程决定。
