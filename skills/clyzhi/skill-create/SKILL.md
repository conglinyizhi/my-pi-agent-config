---
name: skill-create
description: 高质量技能创作指南。当用户要求创建/编写/设计一个新技能时调用。
---

# 技能创作

## 触发条件

- 用户要求"创建/写/设计一个 skill/技能"
- 用户说"把这个流程固化下来""总结成可复用的步骤"
- 用户递出本 skill 意图创作

## 执行

按顺序读取并执行以下参考文档：

1. **读取 `references/hermes-original.md`** — 原始创作规范全文（基于 NousResearch/hermes-agent，MIT 许可），包含 YAML 表头规则、章节顺序、工具框架、质量门槛
2. **可选：读取 `references/self-evolution-blueprint.md`** — 如果用户提及"优化""进化""自动改进"等关键词
3. 严格按照规范生成 `SKILL.md`，用 `write` 工具写入目标路径
4. 完成后简要报告：技能名、类别、一句话摘要
