# 搜索展开 Skill 计划书

> 状态：草案 | 日期：2025-07-30

## 目标

一个轻量 skill，让 LLM 根据用户的查询意图，生成 4-5 组结构化搜索词。配合传统搜索（语义/向量/关键词）使用，提升上下文命中率。

## 核心理念

用户的输入宽度通常为 1——一个描述、一个概念、一个模糊意图。LLM 的强项不是搜索，而是**把一个模糊意图展开成多角度、多语言、多层次的搜索词**。

原始搜索宽度 = 1 → skill 展开 → 宽度 = 4~5 → 搜索结果覆盖面和命中率指数级提升。

skill 本身不做搜索、不做排序，只输出结构化搜索词。

## 设计

### 输入

- 用户的查询/当前对话上下文
- core-prompt（可选，用于个性化展开）

### 输出

结构化 JSON，每组搜索词附带类型和权重：

```json
{
  "original": "林汐的状态栏怎么改",
  "expansions": [
    {
      "group": "api",
      "weight": 1.0,
      "terms": ["pi setStatus", "ctx.ui.setStatus", "ExtensionUIContext", "footer 状态栏 API"]
    },
    {
      "group": "implementation",
      "weight": 0.9,
      "terms": ["pi-web sessiond Proxy", "setFooter 自定义 footer", "状态栏右对齐 实现"]
    },
    {
      "group": "concept",
      "weight": 0.8,
      "terms": ["TUI footer customization", "agent name display status bar", "terminal UI 定制"]
    },
    {
      "group": "context",
      "weight": 0.7,
      "terms": ["trident-routing 林汐", "母港 homeport", "pi 扩展 status"]
    },
    {
      "group": "english",
      "weight": 0.6,
      "terms": ["pi coding agent status bar right align", "custom footer ExtensionUIContext proxy"]
    }
  ]
}
```

### 展开策略

| 策略 | 说明 | 示例 |
|------|------|------|
| **同义表述** | 同一个东西的不同说法 | 「状态栏」→ 「footer」「status line」「状态行」 |
| **上下位概念** | 向上抽象 / 向下细化 | 「状态栏」→ 「UI 定制」→ 「ExtensionUIContext」→ 「pi 扩展 API」 |
| **中英双语** | 同时输出中文和英文搜索词 | 「状态栏」→ 「status bar」 |
| **实现细节** | API 名、文件路径、函数名、配置键 | `setStatus`、`piSessionService.ts` |
| **上下文关联** | 搜索历史中提到的相关项目/模块/概念 | 「trident-routing」→ 「母港」「setStatus("trident")」 |
| **拆分命中** | 长词拆成独立字/词 | 「右对齐」→ 「右」+「对齐」+「right align」 |

### Core-prompt 集成

展开前读取 core-prompt，注入用户画像：

```
当前用户技术栈：TypeScript · Vue 3 · pi agent · Fastify · Tailwind
项目偏好：pnpm · systemd · 不沾 Python
活跃项目：trident-routing · pi-web-gui · pi-webd-server
```

这样「状态栏」不会被展开成「React footer component」之类的无关方向。

## 与传统搜索对接

skill 输出搜索词 → 传统搜索层消费：

```
搜索词 JSON
  │
  ├─→ BM25 / 关键词命中（精确匹配）
  ├─→ 向量相似度（语义匹配）
  ├─→ 二级词拆分为字/词独立匹配（字符级命中，兜底）
  └─→ LLM 重排序（对候选结果二次筛选）
```

skill 不关心搜索实现——它只负责把 1 变成 5。

## 使用场景

| 场景 | 触发方式 |
|------|---------|
| 日常对话中自动展开 | 静默读 core-prompt，自动生成上下文相关的搜索词 |
| 显式搜索 | 用户用 `/search` 或自然语言：「帮我查一下 X」|
| 代码探索 | 结合当前打开的文件/项目，展开相关 API、文件路径 |
| 知识库搜索 | 对 core-prompt 中记录的项目、偏好进行关联展开 |

## 技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| Skill 格式 | SKILL.md | pi 标准，触发词匹配 |
| 输出格式 | JSON | 结构固定，下游直接消费 |
| 人格注入 | core-prompt（读取 `~/disk/core-prompt/skill/`） | 个性化展开 |
| 搜索层 | 后续决定（向量/BM25/LLM 重排） | 独立模块，不写在 skill 里 |

## 开发阶段

### Phase A：Skill 本体（~80 行 SKILL.md）

- 展开策略描述
- JSON 输出格式定义
- 与 core-prompt 的集成点
- 触发词设计

### Phase B：搜索层对接（独立模块）

- BM25 / 关键词命中引擎
- 向量嵌入 + 相似度匹配（可选，取决于有无本地向量库）
- 字/词级拆分匹配（兜底）
- LLM 重排序

### Phase C：上下文感知

- 自动检测当前项目、打开文件、活跃扩展
- 自动读取 core-prompt 相关模块
- 搜索结果注入聊天上下文的格式约定

## 文件位置

```
~/.pi/agent/skills/search-expand/
├── SKILL.md              ← skill 本体
└── README.md             ← 本计划书
```

---

## 下一步

1. 写 Phase A：`SKILL.md`，定义展开策略 + 输出格式
2. 手动测试：给林汐一个查询，看展开质量
3. 调整展开策略（哪些策略最有效，权重如何分配）
4. Phase B：写搜索层
