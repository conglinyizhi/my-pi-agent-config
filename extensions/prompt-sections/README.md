# prompt-sections — DSH 风格的有序段系统提示词组装

把 DeepSeek Harness（`@deepseek-ai/dsh-system-prompt`）的系统提示词组装机制移植到 pi：
**有序段（section）注册表 + 严格变量插值 + complete 段 + KV-cache 纪律**。
来源与设计依据：`docs/plans/2026-08-15-dsh-architecture-migration.md` §6。

## 做什么

- 其他扩展在 factory 里注册**命名、带 order 的提示词段**，装配时按 order 升序拼接：
  ```
  [-100 身份] [0 pi:default 默认提示词] [50 策略] [100-199 工具指导] [200+ 动态]
  ```
- `before_agent_start` 时由本扩展装配并整体替换 `systemPrompt`（链式语义：装配产出包含完整
  默认文本，skill-kit / tool-checker 等下游文本变换无论先后都能工作）。
- **pi:default 段** = pi 默认组装好的系统提示词（SYSTEM.md 人格 + 工具 + 指南 + 文档 + context +
  skills + cwd）；注册同名段即可整体遮蔽（persona 替换，等价 DSH `dsh-persona`）。
- **complete 段**：注册 `complete: true` 的段装配后成为唯一提示词（仍解析变量）；多个抛错。
- **严格变量**：`{{model}}` / `{{cwd}}` / `{{date}}` / `{{time}}` 内建；已注册变量 undefined 抛错；
  未注册引用保留字面量（pi 链兼容：skill-kit 的 `{{PI_*}}` 占位符由它自己在下游替换）。

## A/B 开关（对照 v0.1.0 tag）

| 方式 | 说明 |
|---|---|
| `settings.json` → `"promptSections": true` | 持久，推荐（会被 settings-sync 同步进 tracked） |
| `pi --prompt-sections` | CLI flag，会话内有效 |
| `/prompt-sections on\|off\|status` | 运行时切换并写回 settings.json |
| `/prompt-sections-preview` | 打印当前装配后的提示词前 60 行（验收用） |

关闭 = 完全不改动系统提示词，保持 v0.1.0 行为。装配失败只 warn 一次并回退默认，绝不破坏会话。

## 给其他扩展作者

```ts
import { registerSection, registerVariable, isPromptSectionsEnabled } from "../../lib/prompt-sections.ts";

// 无条件注册（禁用时不会被装配，注册本身无害——无需感知扩展加载顺序）
registerSection({
  name: "tool-guidance:my-ext",   // 唯一名；同名后注册遮蔽先注册
  order: 150,                     // 约定：-100 身份 / 0 默认 / 50 策略 / 100-199 工具指导 / 200+ 动态
  text: async (ctx) => {          // 静态字符串或按次装配求值（可异步）
    await ensureReady();
    return "…";                   // 空串 = 空段丢弃
  },
  complete: false,                // true = 装配后成为唯一提示词（慎用）
});

registerVariable("ext_time", (ctx) => new Date().toISOString());

// 需要知道是否启用（如切换 v0.1.0 行为回退时）：
if (isPromptSectionsEnabled()) { /* 走段；否则保持旧行为 */ }
```

- 注册表是**纯 TS、零 pi 依赖**的模块（`lib/prompt-sections.ts`），可单测、可被任何扩展 import。
- 同名重复注册 = **遮蔽**（后注册者替换先注册者）；`registerSection` 返回 disposer。
- 变量 provider 返回 `undefined` → 渲染抛 `PromptVariableError`；替换后的值不再二次扫描。
- 禁用时 `assemble` 永远不会被调用，注册的段不产生任何效果。

## 已迁移的示例

- **tool-checker**：`tool-guidance:tool-checker`（order 150，装配时 `await ensureChecksDone()` 后渲染）；
  启用时其事件处理器直接 return（由段承载），关闭时保持 v0.1.0 追加行为。
- **skill-kit**：`tool-guidance:skill-triggers`（order 110，装配时按 repo 配置求值 trigger 预检表）；
  其 handler 的占位符/日期/技能过滤等文本变换保留在链上，仅 trigger 追加在启用时让位给段。
- **plan-mode**：`policy:plan-mode`（order 50，装配时按当前模式求值 [PLAN MODE ACTIVE] /
  [EXECUTING PLAN] 策略；未激活 → 空段丢弃）；启用时不再注入 message（v0.1.0 行为保留为回退）。
  迁移方向与 DSH 一致（DSH plan mode 即 order-50 策略段），且段在系统前缀、对 KV 缓存更友好。
- **trident-routing**：`persona:homeport`（order 0, `complete: true`；非母港 → 空段丢弃不构成
  complete）；启用时 handler 让位，关闭时保持 v0.1.0 整体替换。这是「母港替换」语义的
  一等公民表达：维修模式 = 唯一 complete 段。

以上各扩展的 v0.1.0 行为均保留为关闭开关时的回退路径。

## 已知交互

- **母港模式（trident-routing）**：已迁移为 `persona:homeport` complete 段——母港时装配只保留
  该段（含变量解析），非母港时空段丢弃、正常装配。若关闭 prompt-sections，回落 v0.1.0 的整体替换。
- **扩展加载顺序**：pi 的扩展发现是文件系统序（不可依赖）。本设计不依赖顺序：装配在链上任一
  位置都安全（产出含完整默认文本），段注册在工厂期无条件完成、仅运行时门控。

## 测试

```bash
node --experimental-strip-types extensions/prompt-sections/registry.test.ts
```

覆盖：order 拼接/空段丢弃、pi:default 遮蔽、严格变量（undefined 抛错/未注册保留/不二次扫描）、
complete 段（唯一/多段抛错/空段不算）、disposer 语义、非法变量名、按次求值。
