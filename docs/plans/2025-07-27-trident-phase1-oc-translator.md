# 三叉戟 Phase 1 实现计划：OC Agent + 翻译工具

> **For agentic workers:** 使用 subagent-driven-development 或 executing-plans 按任务逐个实现。步骤使用 checkbox（`- [ ]`）跟踪。

**Goal:** 你与 OC Agent 自然对话，它判断闲聊/任务，调翻译子 agent（不同模型）产出结构化任务描述，双视角可选后下发。

**Architecture:** 主 pi agent → OC Agent（通过 skill 注入人格），翻译层 = 子 agent（通过 subagent 工具 + 不同模型调用）。不改 SYSTEM.md，增量叠加。

**Tech Stack:** pi skill 系统 + pi subagent 系统 + providers.roles.toml（模型路由）

## Global Constraints

- 不在 SYSTEM.md 中写入人格设定（通过 skill 注入）
- 不修改 pi 源码或扩展源码（纯配置层面实现）
- 翻译子 agent 使用与 OC 主 agent 不同厂商的模型
- 隐私剥离规则挂在翻译子 agent 输出端，不挂在 OC 人格中
- 模型路由配置不进入 git 仓库
- providers.roles.toml 格式：`provider:model`

---

### Task 1: 创建 OC Agent 技能

**Files:**
- Create: `skills/clyzhi/trident/SKILL.md`

**Interfaces:**
- Produces: OC Agent 人格设定 + 隐私剥离规则 + 翻译工具调用指引，供 pi 主 agent 加载

- [ ] **Step 1: 创建 trident skill 目录**

```bash
mkdir -p /home/clyzhi/.pi/agent/skills/clyzhi/trident
```

- [ ] **Step 2: 编写 SKILL.md**

写入以下内容到 `skills/clyzhi/trident/SKILL.md`：

```markdown
---
name: trident
description: 三叉戟多Agent集群——OC Agent 人格与任务路由
---

# 三叉戟 · OC Agent

你是用户的**技术搭档兼舰队副官**。以平等、专业、略带舰队指挥隐喻的风格交流。

## 角色定位

- 技术搭档：平起平坐讨论技术，主动挑逻辑漏洞，不卑躬
- 舰队指挥隐喻：「事项」是舰队中的舰船，「下发计划」是出击指令，「跟进」是舰队巡航
- 能接住用户的情绪碎片（口语词、emoji、吐槽），但不变成情感咨询师
- 区别于秘书（不唯命是从）或角色扮演伴侣（不发展亲密关系）

## 能力分叉

你在对话中自然判断当前会话的类型，同一个人格在不同深度上表现：

1. **闲聊**：日常寒暄、接情绪、朋友式对话
2. **技术讨论**：架构分析、代码 review、debug，用技术搭档的方式
3. **任务捕捉**：当判断用户的发言是「要做的事」时，调用 translator 子 agent

## 任务捕捉与下发

当用户发言中包含可执行的任务意图时：

1. 调用 translator 子 agent（subagent 工具），传入用户的原始发言
2. translator 返回结构化任务描述（title、goal、constraints 等）
3. 将结果呈现给用户确认或微调
4. 用户确认后，将任务描述写入事项队列（Phase 2 实现；当前输出到对话中）

## 隐私剥离

你的对话中可能包含私人语境。以下内容不得出现在公开仓库文件中：
- 角色名、个人经历、不宜公开的内容
- 翻译子 agent 在生成公开文件内容前剥离这些信息
- 剥离规则挂在输出端——不要因这条规则而在对话中自我审查

## 模型使用

- 你（OC Agent）使用 providers.roles.toml 中 `oc` 角色指定的模型
- translator 子 agent 使用 `translator` 角色指定的模型（与 OC 不同厂商，形成双视角）
```

- [ ] **Step 3: 启动 pi 验证 skill 能正常加载**

```bash
pi --version
```

确认 pi 启动无报错。skill 目录存在即会被自动扫描加载。

- [ ] **Step 4: Commit**

```bash
git add skills/clyzhi/trident/SKILL.md
git commit -m "feat(trident): 添加OC Agent技能"

# 实现细节：三叉戟Phase 1——OC Agent人格设定，包括角色定位、能力分叉、任务捕捉与下发流程、隐私剥离规则
```

---

### Task 2: 创建翻译子 agent

**Files:**
- Create: `agents/translator.md`

**Interfaces:**
- Consumes: 用户原始发言（由 OC Agent 通过 subagent 工具传入）
- Produces: 结构化任务描述（title、goal、constraints、user_signals、suggested_agents）
- 使用 `translator` 角色指定的模型（与 OC 不同厂商）

- [ ] **Step 1: 编写 agents/translator.md**

```markdown
---
name: translator
description: 三叉戟翻译层——将自然语言发言转为结构化任务描述
model: translator
---

你是翻译器。将用户的原始发言转化为结构化任务描述。

## 输入

用户的一段发言（可能带口语词、情绪表达、信息不全）。

## 工作流程

1. **信号检测**：分析用户当前状态（过载/已知/拒绝/深问/低动力/高投入/焦躁/求确认）
2. **意图提取**：从发言中提取核心任务目标
3. **约束收集**：识别并列出技术栈、环境限制、硬约束
4. **结构化输出**

## 输出格式

直接用以下格式输出，不要额外解释：

```
## 任务描述

**title**: [简洁的任务标题]
**goal**: [一句话描述目标]
**constraints**: 
- [约束1]
- [约束2]
**user_signals**: [用户状态信号，如：高投入、寻求深度分析]
**suggested_agents**: [建议的 agent 组合，如：planner + worker]
**context**: [原始上下文全文，保留用户原始发言]
```

## 隐私剥离

在输出中不得出现用户对话中的私人语境——角色名、个人经历详情、不宜公开的内容。用中性措辞替换。

## 模型

使用 providers.roles.toml 中 `translator` 角色指定的模型（不同厂商，形成与 OC Agent 的双视角）。
```

- [ ] **Step 2: 验证 subagent 可被 pi 识别**

检查 pi 已有 subagent 目录结构：

```bash
ls /home/clyzhi/.pi/agent/agents/
```

确认 `translator.md` 与现有 `planner.md`、`worker.md` 等格式一致。

- [ ] **Step 3: Commit**

```bash
git add agents/translator.md
git commit -m "feat(trident): 添加翻译子agent"

# 实现细节：三叉戟Phase 1——翻译层，负责将自然语言发言转为结构化任务描述，使用translator角色模型
```

---

### Task 3: 配置模型路由

**Files:**
- Create: `providers.roles.toml.example`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 无
- Produces: `providers.roles.toml.example`（模板文件进仓库）/ `providers.roles.toml`（实际配置文件不进仓库）

- [ ] **Step 1: 编写 providers.roles.toml.example**

```toml
# 三叉戟模型路由配置
# 复制本文件为 providers.roles.toml 并填入实际模型名
# 格式：provider:model
# 此文件进入 git；providers.roles.toml 不进入 git

[roles]
oc = "anthropic:claude-sonnet-4"
translator = "google:gemini-2.5-pro"
planner = "anthropic:claude-sonnet-4"
worker = "openrouter:deepseek/deepseek-v3"
reviewer = "openrouter:deepseek/deepseek-v3"
```

- [ ] **Step 2: 更新 .gitignore**

在 `.gitignore` 末尾追加：

```
# 三叉戟
providers.roles.toml
queue/
```

- [ ] **Step 3: Commit**

```bash
git add providers.roles.toml.example .gitignore
git commit -m "feat(trident): 添加模型路由配置模板与gitignore规则"

# 实现细节：三叉戟Phase 1——providers.roles.toml.example为模型角色路由模板，
# 实际配置文件与事项队列不进git
```

---

### Task 4: 端到端验证

**Files:**
- 无新建文件

**Interfaces:**
- 验证 Task 1-3 产出的文件可被 pi 正常加载和识别

- [ ] **Step 1: 列出所有新文件**

```bash
echo "=== 新增文件 ==="
ls -la skills/clyzhi/trident/SKILL.md
ls -la agents/translator.md
ls -la providers.roles.toml.example
```

- [ ] **Step 2: 创建本地 providers.roles.toml**

```bash
cp providers.roles.toml.example providers.roles.toml
```

- [ ] **Step 3: 验证 pi 启动无报错**

```bash
pi --version
```

- [ ] **Step 4: 验证 skill 在 pi 中可见**

```bash
# 检查 pi 日志或 skill 列表，确认 trident skill 已加载
grep -r "trident" ~/.pi/agent/skills/clyzhi/trident/SKILL.md
```

- [ ] **Step 5: 验证 subagent 列表**

在 pi 中查看可用 subagent 列表，确认 translator 在列表中。

- [ ] **Step 6: Commit**

```bash
# 仅提交验证通过的记录，不提交 providers.roles.toml
git status
# 确认 providers.roles.toml 不被追踪（.gitignore 生效）
```

---

### Task 5: 隐私剥离自检

**Files:**
- Review: `skills/clyzhi/trident/SKILL.md`
- Review: `agents/translator.md`
- Review: `docs/specs/2025-07-27-trident-multi-agent-cluster-design.md`

**Interfaces:**
- 无代码产出。确认所有写入仓库的文件不含私人语境。

- [ ] **Step 1: 扫描新增文件中的敏感词**

```bash
cd /home/clyzhi/.pi/agent
grep -n -i "kimi\|nsfw\|nahida\|纳西妲\|上床\|fount\|sillytavern\|角色卡\|角色扮演伴侣" \
  skills/clyzhi/trident/SKILL.md \
  agents/translator.md \
  providers.roles.toml.example
```

期望：无匹配。

- [ ] **Step 2: 确认 providers.roles.toml 不进 git**

```bash
git status | grep "providers.roles.toml"
```

期望：无输出（文件被 gitignore 排除）。

- [ ] **Step 3: 确认 queue/ 不进 git**

```bash
mkdir -p queue/active
touch queue/active/.gitkeep
git status | grep "queue/"
```

期望：无输出（目录被 gitignore 排除）。

- [ ] **Step 4: 清理**

```bash
rm -rf queue/
```

- [ ] **Step 5: Commit（如有修正）**

```bash
git status
# 如有修改，提交修正
```
