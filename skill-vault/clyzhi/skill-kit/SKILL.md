---
name: skill-kit
description: 技能工具箱。当需要新建技能、从外部导入技能、或管理技能仓库时调用。
disable-model-invocation: true
---

# 技能工具箱

## 触发条件

以下任一场景触发本技能：

- 用户要求"创建/写/设计一个 skill/技能"
- 用户要求"导入/添加一个新技能"（给了 GitHub URL）
- 用户要求从某个技能仓库更新已导入的技能
- 用户要求拆分一个多技能聚合仓库
- 用户说"把这个流程固化下来""总结成可复用的步骤"

## 两大功能

| 功能 | 场景 | 参考文档 |
|------|------|----------|
| **导入技能** | 从外部 GitHub 仓库拉取技能 | `references/import-guide.md`（内含结构说明） |
| **创建技能** | 从零编写新的 SKILL.md | `references/hermes-original.md` |

## 执行

### A. 导入技能

1. 读取 `references/import-guide.md`，按五步走：分析仓库 → 确认范围 → 执行导入 → 更新 repo.toml → 提示 /reload
2. 完成后汇总：导入了哪些技能、来自哪个仓库

### B. 创建技能

1. 读取 `references/hermes-original.md`（基于 NousResearch/hermes-agent，MIT），按规范生成 SKILL.md
2. 如果用户提及"优化""进化""自动改进"等关键词，参考 `references/self-evolution-blueprint.md`
3. 用 `write` 工具写入目标路径
4. 报告：技能名、类别、一句话摘要

### C. 目录结构参考

- 导入流程中的目录结构详见 `references/import-guide.md` 步骤 1-2（内含 `repo-structure.md` 的精简版）
- 如需完整的本地管理体系说明，读取 `references/repo-structure.md`

### D. 注意事项

- 所有技能变更（新增 repo.toml 条目、修改 trigger）后，提示用户 `/reload` 使生效
- 新建技能放入 `skills/clyzhi/<skill-name>/SKILL.md`
- 导入技能通过更新 `repo.toml` + session_start 时自动同步完成
