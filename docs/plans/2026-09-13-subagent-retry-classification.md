# subagent 重试错误分类 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 subagent 的「重试」从「凡是 `stopReason === "error"` 就当瞬时抖动重试 6 次」升级为**按失败类别决策**：配额耗尽不重试、上游流中断才重试、认证/上下文超限/超时直接报错。让失败快、信息准、不再把主 agent 钉在同一批上最多一小时。

**Architecture:** `lib/subagent-retry.ts` 从「一个布尔判定 + 一个通用退避」升级为「**分类器 + 决策器**」两段纯函数：`classifyFailure(input) → FailureClass`，`planRetry(input, ctx) → RetryVerdict`。判据来自结构字段（`SubagentError.status` / `exitCode` / `stopReason`）与**集中在一张表里的文本模式**（`errorMessage` / `stderr`）。`lib/subagent-run.ts` 的重试循环结构不动，只把 `isRetryableFailure` + `backoffDelayMs` 换成 `planRetry`，并把 verdict 的判据写进 timeline，便于事后用 `~/.pi/subagent-diagnostics` 核对。

## 背景证据（来自 32 份真实诊断档案，`~/.pi/subagent-diagnostics`）

48 个 worker 里 25 个触发过重试，5 个跑满 6 次。真实错误串只有两类：

- `Concurrency limit exceeded for account, please retry later`（5 起）——**账号级并发配额**，秒级退避（1→2→4→8→16→30s，总约 61s）对它毫无意义；重试只是把压力再乘一遍。
- `Upstream response stream was interrupted`（2 起）——真·瞬时，值得重试。

最坏耗时与 `SUBAGENT_MAX_ATTEMPTS(6) × timeout(600s) = 3600s` 吻合：实测最长 `batch-mtx1f0yr/w1` = **3536s**。根因在 `lib/subagent-retry.ts:32`（已实测验证）：

```ts
export function isRetryableFailure(input: SubagentResult | unknown): boolean {
  if (input instanceof SubagentError) {
    return input.status === "timeout";   // ← 超时被认为「值得重试」
  }
  ...
  return r.exitCode !== 0 || r.stopReason === "error";  // ← 任何 error 都算瞬时
}
```

实测（`node -e` 直接调）：

```
isRetryableFailure(new SubagentError("timeout", "t"))  // → true   ← 超时会重试
isRetryableFailure(new SubagentError("aborted", "a"))  // → false  ← 正确
isRetryableFailure({ exitCode: 1, stopReason: "error",
  errorMessage: "Concurrency limit exceeded for account, please retry later" })  // → true ← 配额也会重试 6 次
```

**超时也会被重试**，这才是 6×600s 的真正来源：一个已经跑满 10 分钟没出结果的 worker，会被原样重跑最多 6 遍（且每次都是全量重跑，不 resume）。

## Global Constraints

- **纯函数**：`lib/subagent-retry.ts` 不 spawn、不碰网络、不读时钟、不读随机数——时间与随机源一律**注入**，测试才能确定性断言 jitter。
- **不做模型降级**：手上没有可用作降级的其他模型资源，本计划不引入 fallback 模型。
- **不改重试的执行语义**：重试仍是全量重跑（不引入 session resume），本计划只改「要不要重试」和「等多久」。
- **成功路径语义不变**：干净成功直接返回，不写调查文件，不进重试判定。
- **兼容**：`isRetryableFailure` / `backoffDelayMs` 保留为薄包装（委托 `planRetry`），避免一次性改散调用点与既有 64 行测试的语义；新判据以 `RetryVerdict` 为准。
- **测试跑法**：`node --experimental-strip-types lib/subagent-retry.test.ts`、`node --experimental-strip-types lib/subagent-run.test.ts`（全绿，基线：两文件合计 **68 用例** / 0 失败）。
- **分类表必须用真实串写用例**：每条模式至少有一个来自诊断档案的样本，禁止只写杜撰的样例。
- 每次提交只含本任务相关改动，一次一提交。

---

### Task 1: 分类器 `classifyFailure`

**Files:**
- Modify: `lib/subagent-retry.ts`
- Test: `lib/subagent-retry.test.ts`

**Interfaces:**
- Produces:

```ts
export type FailureClass =
  | "quota"          // 账号/租户并发或速率配额耗尽
  | "upstream"       // 上游流中断、连接被重置（真瞬时）
  | "auth"           // 认证/鉴权/模型不存在（配置问题，重试无意义）
  | "context_limit"  // 超出上下文/输出上限（要拆任务，不是重试）
  | "crash"          // 子进程非零退出且无结构化错误（可能 OOM/被杀）
  | "timeout"        // 内部超时控制器触发
  | "aborted"        // 外部 signal 中止
  | "unknown";       // 以上都不匹配

export interface FailureSignals {
  /** SubagentError 携带的结构化终态（若有） */
  errorStatus?: "timeout" | "aborted";
  /** 非 SubagentError 时，失败结果的字段 */
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;
  stderr?: string;
}

/** 把任意失败输入规整成判定用的信号（纯函数） */
export function toFailureSignals(input: SubagentResult | SubagentError | unknown): FailureSignals;

/** 分类：结构信号优先，文本模式兜底；永不抛 */
export function classifyFailure(input: SubagentResult | SubagentError | unknown): FailureClass;

/** 分类用的文本模式表（唯一事实来源；改动必须同步加真实样本用例） */
export const FAILURE_PATTERNS: ReadonlyArray<{ klass: FailureClass; pattern: RegExp }>;
```

**分类判据（按优先级）**

1. `errorStatus === "aborted"` → `aborted`
2. `errorStatus === "timeout"` → `timeout`
3. `stopReason === "aborted"` → `aborted`
4. 文本匹配 `FAILURE_PATTERNS`（依表序，先匹配先归）
5. `exitCode !== 0` 且无任何文本线索 → `crash`
6. 其余 → `unknown`

**`FAILURE_PATTERNS` 初版（顺序敏感：quota 必须在 upstream 之前）**

| klass | pattern（大小写不敏感） |
|---|---|
| `quota` | `concurrency limit`、`rate limit`、`too many requests`、`\b429\b`、`quota exceeded` |
| `auth` | `unauthorized`、`invalid api key`、`\b401\b`、`\b403\b`、`model not found`、`no api key` |
| `context_limit` | `context length`、`too many tokens`、`prompt is too long`、`maximum context` |
| `upstream` | `stream was interrupted`、`connection reset`、`socket hang up`、`ECONNRESET`、`ETIMEDOUT`、`upstream` |

- [ ] **Step 1: 写失败测试**

在 `lib/subagent-retry.test.ts` 追加新 describe（保持既有用例不动）：

- 结构优先：`SubagentError("timeout")` → `timeout`、`SubagentError("aborted")` → `aborted`、`stopReason:"aborted"` → `aborted`。
- 真实串（必须逐字取自诊断档案）：
  - `{ exitCode: 1, stopReason: "error", errorMessage: "Concurrency limit exceeded for account, please retry later" }` → `quota`
  - `{ exitCode: 1, stopReason: "error", errorMessage: "Upstream response stream was interrupted" }` → `upstream`
- 文本取自 `stderr`（`errorMessage` 为空时）也能分类。
- `{ exitCode: 137 }`（SIGKILL/OOM 常见值）无文本 → `crash`。
- 完全无线索的 `{ exitCode: 1, stopReason: "error" }` → `unknown`。
- `null` / 字符串 / `new Error("boom")` 不抛，返回某个合法 `FailureClass`。
- `FAILURE_PATTERNS` 表自检：`quota` 在 `upstream` 之前（防顺序回归）。

- [ ] **Step 2: 跑测试确认失败**

`node --experimental-strip-types lib/subagent-retry.test.ts` —— 因新导出不存在而失败。

- [ ] **Step 3: 实现**

在 `lib/subagent-retry.ts` 增加上述接口。要点：

- `toFailureSignals` 用 `instanceof SubagentError` 判结构化终态；否则读对象的 `exitCode/stopReason/errorMessage/stderr` 字段（类型守卫而非断言，非对象一律给空信号）。
- 文本拼接 `errorMessage + "\n" + stderr` 后统一匹配，**不抛**（`try/catch` 兜 `unknown`）。
- 模式表 `export` 出去，供测试与后续运维核对。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

`feat(subagent): 失败分类器 classifyFailure`

---

### Task 2: 决策器 `planRetry`

**Files:**
- Modify: `lib/subagent-retry.ts`
- Test: `lib/subagent-retry.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RetryVerdict {
  klass: FailureClass;
  /** 是否值得再试一次 */
  retry: boolean;
  /** 本次建议退避毫秒（已含 jitter）；retry=false 时为 0 */
  delayMs: number;
  /** 本次已消耗的失败次数（含本次） */
  failureCount: number;
  /** 人类可读判据，写进 timeline 供事后核对 */
  reason: string;
}

/** 每类的重试预算与退避（集中一张表，便于调参与核对） */
export const RETRY_POLICY: Record<FailureClass, {
  maxAttempts: number;   // 该类的总尝试次数上限（含首次）
  baseDelayMs: number;   // 首次退避基数
  maxDelayMs: number;    // 单次退避上限
}>;

export interface PlanRetryContext {
  /** 本次失败后累计的失败次数（1-based） */
  failureCount: number;
  /** 已发过 capability grant → 一律不重试（grant 是否被消费不确定） */
  capabilityGrantIssued?: boolean;
  /** jitter 随机源（0..1），注入以便确定性测试；缺省 Math.random */
  random?: () => number;
  /** jitter 幅度，缺省 0.25（±25%） */
  jitterRatio?: number;
}

export function planRetry(
  input: SubagentResult | SubagentError | unknown,
  ctx: PlanRetryContext,
): RetryVerdict;
```

**`RETRY_POLICY` 初版**

| klass | maxAttempts | baseDelayMs | maxDelayMs | 理由 |
|---|---|---|---|---|
| `quota` | 1（不重试） | — | — | 账号级配额不会在秒级恢复；重试加剧压力（实测 5 起） |
| `upstream` | 3 | 1000 | 8000 | 真瞬时（实测 2 起） |
| `crash` | 3 | 1000 | 8000 | 可能 OOM/被杀，换个时刻有戏 |
| `unknown` | 2 | 2000 | 2000 | **保守**：未知错误每次重试 = 一次全量重跑（最长 10 分钟），最多给它一次机会 |
| `auth` | 1 | — | — | 配置问题，重试无意义，要让主 agent 立刻看到 |
| `context_limit` | 1 | — | — | 要拆任务/换简报，不是重试 |
| `timeout` | 1 | — | — | **本次修复的核心**：跑满 600s 没结果，原样重跑大概率还是 600s |
| `aborted` | 1 | — | — | 用户主动取消（保持现状语义） |

**退避**：`delay = min(baseDelayMs * 2^(failureCount-1), maxDelayMs)`，再乘 `1 ± jitterRatio` 抖动（防同批 worker 同步重试）。`maxAttempts` 判定用 `failureCount >= maxAttempts → retry=false`。

- [ ] **Step 1: 写失败测试**

- 各类别：`quota` / `auth` / `context_limit` / `timeout` / `aborted` 一律 `retry=false`、`delayMs=0`。
- `upstream` / `crash`：第 1 次失败 `retry=true`；达到 `maxAttempts` 后 `retry=false`。
- `unknown`：第 1 次 `retry=true`，第 2 次 `retry=false`（保守默认，钉死这条回归）。
- 超时回归（**本计划的存在理由**）：`SubagentError("timeout")` → `retry=false`，且 `reason` 说明「超时不重试」。
- `capabilityGrantIssued: true` 时任何类别都 `retry=false`。
- jitter：注入 `random: () => 0` 与 `random: () => 1` 各跑一次，断言 `delayMs` 分别落在 `base*(1-ratio)` 与 `base*(1+ratio)` 附近；`random` 缺省时不抛。
- 退避上限：`failureCount` 很大时不超过 `maxDelayMs * (1 + jitterRatio)`。
- `reason` 非空且含类别名（供 timeline 核对）。
- `RETRY_POLICY` 表自检：每个 `FailureClass` 都有条目（`Object.keys(RETRY_POLICY).length === 8`），且 `maxAttempts >= 1`。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

要点：`planRetry` 内部先 `classifyFailure`，再查 `RETRY_POLICY`，再算退避；`capabilityGrantIssued` 短路在最前（与现行 `subagent-run.ts` 的 `capabilityGrantIssued` 语义一致）。`Date.now()` 一律不用。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

`feat(subagent): 重试决策器 planRetry（按类别给预算与退避）`

---

### Task 3: `runSubagent` 接线 + verdict 落轨迹

**Files:**
- Modify: `lib/subagent-run.ts`
- Test: `lib/subagent-run.test.ts`

**Interfaces:**
- Consumes: `planRetry` / `RetryVerdict`（Task 1–2）
- 既有导出保持可用：`SUBAGENT_MAX_ATTEMPTS`、`backoffDelayMs`、`isRetryableFailure` 改为薄包装（委托 `planRetry`），保留给既有测试与外部引用。

- [ ] **Step 1: 写失败测试**（`lib/subagent-run.test.ts` 的 `runSubagent retry loop (injected runOnce)` 段）

- `runOnce` 返回 `errorMessage: "Concurrency limit exceeded..."` → **只跑 1 次**（`n === 1`），且结果是 `failed` 带 `investigationPath`（不重试但要留档）。
- `runOnce` 返回 `errorMessage: "Upstream response stream was interrupted"` → 跑 3 次后停（`n === 3`）。
- 抛 `SubagentError("timeout")` → 只跑 1 次（**回归：现行会跑 6 次**）。
- `sleep` 收到的毫秒数：`upstream` 第 1 次失败后落在 `[750, 1250]`（1000 ± 25%）。
- timeline 里出现 verdict 判据 lifecycle（断言存在含 `quota` / `说不重试` 之类关键词的 lifecycle 消息）。
- 既有用例全部保持通过（`fail then success → 2 runs`、`6 failures → attempts=6` 若因保守默认而语义变化，按新语义更新并在此步说明）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

- 循环里把 `isRetryableFailure(result/x) || failureCount >= max` 的判定换成：

```ts
const verdict = planRetry(failed, {
  failureCount,
  capabilityGrantIssued,
  // 注入 jitter 源以便测试确定性；生产用缺省
  random: opts.retryRandom,
});
if (!verdict.retry) break;
await sleep(verdict.delayMs, opts.signal);
```

- `RunSubagentOptions` 增加可选 `retryRandom?: () => number`（仅测试注入，生产不传）。
- 每轮失败后往 `timeline` / `archiveTimeline` 加一条 lifecycle：`state: "retry-skipped" | "retrying"`，`message` 用 `verdict.reason`。注意：该 lifecycle 必须进 **archiveTimeline**（实时 timeline 有 500 条上限，重试判据丢了就查不到）。
- 更新 `runSubagent` 头部注释（现在写的是「最多 SUBAGENT_MAX_ATTEMPTS 次基础设施重试」，要改成按类别）。
- `SUBAGENT_MAX_ATTEMPTS` 保留为「所有类别里的最大尝试次数」上界（当前表中最大值 3），供既有断言与总轮次保险使用；如需保留常量值 6 以免破坏外部引用，则在注释里说明其含义已收窄。

- [ ] **Step 4: 跑测试确认通过**（`lib/subagent-retry.test.ts` + `lib/subagent-run.test.ts`）

- [ ] **Step 5: 提交**

`fix(subagent): 重试按失败类别决策，配额/超时不再重试`

---

### Task 4: 用真实档案定版 + 观感验收

**Files:**
- Modify: `lib/subagent-retry.test.ts`（只加用例）
- 可选新增：`docs/specs/subagent-retry-classification.md`（把最终的分类表与判据固定成规格）

- [ ] **Step 1:** 从 `~/.pi/subagent-diagnostics/*.json` 抽出全部 `failed` worker 的 `output` / `stderr` 文本，去重后作为样例集合（当前已知两串，见「背景证据」）。
- [ ] **Step 2:** 为每一个真实串补一条 `classifyFailure` 断言；若出现新类别，回到 Task 1 补模式与表序。
- [ ] **Step 3:** 跑一次真实派发（≥3 个 worker）验证：诊断档案里每个 worker 都有清晰的 retry 判据 lifecycle，且失败不再拖到 6 轮。
- [ ] **Step 4:** 把最终分类表写进 `docs/specs/`，作为下次调参的事实来源。
- [ ] **Step 5: 提交**

`test(subagent): 重试分类用真实失败串定版`

---

### Task 5（可选，相邻项）: 单 worker 跨 attempt 总预算

> 与分类正交，但同一个函数里最省事；若只想先修分类，可单独排期。

**问题**：`timeout` 是**每次 attempt 各有一份 600s 预算**（`lib/subagent-run.ts` 的 `defaultRunOnce` 内新建超时控制器）。就算分类把大多数类别都判成不重试，`upstream`/`crash` 仍可累计 3×600s = 30 分钟，主 agent 全程同步阻塞。

**方案**：`runSubagent` 增加跨 attempt 的 wall-clock 预算 `SUBAGENT_TOTAL_BUDGET_MS`（建议 900_000 = 15 分钟）；每次进 attempt 前比较已耗时，超预算就不再重试并直接按当前终态返回，`reason` 写明「总预算耗尽」。

- [ ] **Step 1:** 写失败测试（注入时钟，断言第 N 轮后不再重试且 reason 含「总预算」）。
- [ ] **Step 2–4:** 实现 + 跑通。
- [ ] **Step 5:** `feat(subagent): 重试加跨 attempt 总预算上限`

---

## 明确不做（避免实现时跑偏）

- **模型降级 / 备用 provider**：没有可用作降级的模型资源，不引入。
- **重试改 resume**：仍为全量重跑。若将来要省 token 再单独立项（需 worker 侧会话续接能力）。
- **并发节流**：已在 `extensions/trident-subagent/batch.ts` 落地（`DEFAULT_MAX_PARALLEL_WORKERS`），本计划不碰。
- **skill 解析**：已改为 pi 权威发现结果（`extensions/trident-subagent/skill-refs.ts`），本计划不碰。
- **按 provider 差异化策略**：单一 provider 场景下无收益，等真有多 provider 再说。

## 收尾清单

- [ ] `node --experimental-strip-types lib/subagent-retry.test.ts lib/subagent-run.test.ts` 全绿
- [ ] `./node_modules/.bin/tsc --noEmit` 无非既有报错（既有基线：`lib/subagent-run.test.ts` 7 条 + `lib/subagent-retry.test.ts` 1 条，均为测试夹具缺 `visibleConversation`/`archiveTimeline`）
- [ ] `quota` / `timeout` 两类确认不重试（本次修复的核心行为）
- [ ] 真实派发一次，诊断档案里能看到每轮的 retry 判据 lifecycle
