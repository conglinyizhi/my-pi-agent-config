# 技能创作规范

> 核心规则提炼自 [Hermes Agent](https://github.com/NousResearch/hermes-agent)
> Copyright (c) 2025 Nous Research — MIT License
>
> 以下规范已适配 pi/agent 工具生态。原始 Hermes 规范见末尾附注。

---

## 一、YAML 表头（Frontmatter）

```yaml
---
name: skill-name              # 必需，≤64 字符，小写连字符，无空格
description: 一句话描述        # 必需，≤60 字符，以句号结束
version: 0.1.0                # 可选
author: pi-agent              # 固定值，绝不从环境变量获取
platforms: [linux]            # 可选 — 仅当有 OS 绑定依赖时声明
metadata:                     # 可选
  tags: [标签一, 标签二]
  related_skills: [关联技能名]
---
```

### description 规则（最常违规）

- **≤60 字符**，超出部分会被截断，形同虚设
- 状态能力，不描述实现。禁止"强大的""全面的""先进的""鲁棒的"等营销词
- 结尾加句号
- 不要重复 skill name

```
✅ (48 chars): "搜索 arXiv 论文，支持关键词、作者和 ID 查询。"
❌ (123):     "一个全面的技能，让代理能够使用关键词、作者和分类来搜索 arXiv 学术论文。"
```

---

## 二、章节顺序

以下章节按顺序出现，不需要的章节直接省略：

| # | 章节 | 说明 |
|---|------|------|
| 1 | `# 标题` + intro | 2–3 句：做什么、不做什么、依赖立场 |
| 2 | `## 触发条件` | 具体的触发短语列表，作为 agent 路由判断依据 |
| 3 | `## 执行` | 核心流程——步骤、命令、检查点 |
| 4 | `## 示例` | 输入→输出对照（如有） |
| 5 | `## 注意事项` | 已知限制、频率限制、看起来坏但其实正常的事项 |
| 6 | `## 验证` | 单条命令/检查，证明技能确实生效 |

---

## 三、工具框架规则

pi/agent 的工具集是 `read`、`bash`、`edit`、`write`。在技能中引用工具时必须遵守以下映射：

### 使用 pi/agent 工具名，禁止用裸 shell 命令

| 场景 | ✅ 用这个 | ❌ 不要用 |
|------|----------|----------|
| 读文件 | `read` 工具 | cat/head/tail |
| 搜索文件 | `bash` + `find`/`grep` | （pi/agent 无专用搜索工具，用 bash 替代） |
| 编辑文件 | `edit` 工具 | sed/awk |
| 写文件 | `write` 工具 | echo > file / heredoc |
| 执行命令 | `bash` 工具 | 直接写裸命令 |

### 第三方 CLI 的处理

`gh`、`ffmpeg`、`uv` 等第三方 CLI 在 `bash` 中直接使用即可，但文中仍写"通过 `bash` 工具执行"。

### 引用格式

- 工具名用反引号：`` `read` ``、`` `edit` ``
- 参数用方括号标注：`` `edit(path="...", oldText="...", newText="...")` ``

---

## 四、质量门槛

### 写前必收集

1. 先 `read` 所有用户指定的源文件、文档
2. 确认你在引用**实际存在的**命令、API、路径——绝不编造
3. 如果源中没有某个 flag/path/API，不要写进技能

### 体量控制

- 简单技能 ~100 行
- 复杂技能 ~200 行
- 不要把源文档原文复制过来——提炼核心路径即可
- 大段脚本放到 `scripts/` 目录，技能文中用相对路径引用

### 安全约束

- 不得包含 API 密钥、Token、密码
- shell 命令不得包含 `rm -rf /`、`chmod 777` 等危险操作
- 外部 URL 加注释说明其用途

### 风格

- 用精确命令、端点 URL、函数签名
- 紧凑、可扫读
- 不要写"路由/索引/中心"技能——技能之间通过 `related_skills` 关联
- 不要为了凑章节而写空话

---

## 五、创作流程

```
用户请求 → 阅读本规范 → 收集源材料 → 按规范起草 SKILL.md → write 写入
```

1. **收集源材料**：用 `read` 读本地文件/目录，用 `bash` + `curl` 等获取远程文档
2. **起草**：严格按本规范的章节顺序和工具框架撰写
3. **自查**：写完逐项过一遍质量门槛，特别是 description ≤60 字符
4. **写入**：用 `write(path="skills/<类别>/<技能名>/SKILL.md", content="...")` 写入
5. **报告**：告知技能名、类别、一句话摘要

---

## 附：原始出处

本规范核心思想源于 NousResearch/hermes-agent 的 `AGENTS.md` 和 `agent/learn_prompt.py` 中的 `_AUTHORING_STANDARDS`。

```
MIT License
Copyright (c) 2025 Nous Research
https://github.com/NousResearch/hermes-agent
```

原始 Hermes 规范使用 `terminal`/`read_file`/`write_file`/`patch` 等 Hermes 专有工具名，本文件已适配为 pi/agent 的 `read`/`bash`/`edit`/`write` 工具生态。
