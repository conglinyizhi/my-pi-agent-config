---
name: moonbit-skills-guide
description: >
  MoonBit 技能全家桶索引与装载引导。列出全部 MoonBit 相关技能（官方 9 个 +
  热修复层 1 个）的存放位置、作用与装载方式，以及技能开发/维护入口。需要
  MoonBit 开发能力时，按本索引装载对应技能。本技能只做引导，不替代技能正文。
---

# MoonBit 技能索引 · 装载引导

> 本技能是**索引**，不是技能正文。它告诉你有哪些 MoonBit 技能、它们放在哪、怎么装载。
> 需要具体能力时再装载对应技能（`/skill-boot <名>` 或 read 正文），不要一次性全部注入。
> 路径前缀 `~/.pi/agent` = 本机 pi 配置目录（AGENT_DIR），换机同步后相对位置不变。

## 技能全家桶（10 个）

技能本体挂载在 `~/.pi/agent/skill-vault/`（软链接，实际内容在 `skill-repo/`）。

| 技能                            | 作用                                                                   | 正文入口                                             |
| ------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `moonbit-orientation`           | 一切 MoonBit 问题首选：诊断/API/工具链/FFI/测试，选对 source of truth  | `skill-vault/moonbit-orientation/SKILL.md`           |
| `moonbit-agent-guide`           | 编写/重构/测试 MoonBit 项目的通用工作流                                | `skill-vault/moonbit-agent-guide/SKILL.md`           |
| `moonbit-refactoring`           | 重构为地道 MoonBit：收 API、函数转方法、view 模式匹配、循环不变量      | `skill-vault/moonbit-refactoring/SKILL.md`           |
| `moonbit-proof`                 | 证明携带代码：Why3 spec、抽象函数、表示不变量                          | `skill-vault/moonbit-proof/SKILL.md`                 |
| `moonbit-c-binding`             | C FFI 绑定：extern "c"、moonbit.h、ownership、callback、ASan           | `skill-vault/moonbit-c-binding/SKILL.md`             |
| `make-moonbit-c-bindings`       | 完整 C/C++ 库绑定流程：上游调研→vendoring→API 设计→文档测试→ASan       | `skill-vault/make-moonbit-c-bindings/SKILL.md`       |
| `moonbit-spec-test-development` | 形式化 spec 驱动开发：spec.mbt、declare 桩、contract-first             | `skill-vault/moonbit-spec-test-development/SKILL.md` |
| `moonbit-extract-spec-test`     | 从已有实现提取 spec 与测试套件                                         | `skill-vault/moonbit-extract-spec-test/SKILL.md`     |
| `ocaml2moonbit-migration`       | OCaml → MoonBit 迁移：变体/记录/异常/ref 映射                          | `skill-vault/ocaml2moonbit-migration/SKILL.md`       |
| `clyzhi-moonwell-spring`        | 官方技能热修复层（月井之春）：**必须与官方技能同时加载**，冲突以它为准 | `skill-vault/clyzhi-moonwell-spring/SKILL.md`        |

## 装载方式

1. `/skill-boot <名>` —— skill-boot 扩展注入该技能 SKILL.md 全文进上下文
2. 直接 `read` 上表正文入口
3. 推荐组合：`moonbit-orientation`（先定位）+ 任务对应技能 + `clyzhi-moonwell-spring`（热修复，若涉及工具链新特性）

## 使用规则

- 热修复层 `clyzhi-moonwell-spring` 不重复官方内容，只记录官方未覆盖/已过时的部分，与官方技能冲突时以它为准
- 官方技能可能滞后于 moon 工具链：`moon ide doc` 是 API 发现首选，工具实际输出与文档冲突时以输出为准
- 配置类问题（moon.mod / moon.pkg / moon.work）与工具链新特性优先查热修复层补丁索引 `skill-vault/clyzhi-moonwell-spring/references/patches.min.md`

## 技能开发/维护入口

- 官方技能聚合仓库：`~/.pi/agent/skill-repo/moonbit-skills/`（README、`skills.sources.json` 定义各技能来源仓库/ref/path、`scripts/`）
- 热修复层仓库：`~/.pi/agent/skill-repo/clyzhi-moonwell-spring/`（`references/patches.md` 补丁详情、`references/update-workflow.md` 更新流程）
- 本机装载配置：`~/.pi/agent/skill-repo/repo.toml`（`moonbit-skills` bundle 的 link_targets 定义暴露哪些子技能）
- 用户说「更新 moonwell-spring」或 moon 版本变更 → 沿 `update-workflow.md` 滚动更新热修复层
