# 三叉戟 Phase 1 实现计划：OC Agent + 翻译工具

> **For agentic workers:** 使用 subagent-driven-development 或 executing-plans 按任务逐个实现。步骤使用 checkbox（`- [ ]`）跟踪。

**Goal:** 你与 OC Agent 自然对话，它判断闲聊/任务，调用 translate_task 工具（单次 LLM API，不占子 agent）产出结构化任务描述。

**Architecture:** OC Agent 人格写入 SYSTEM.md。翻译层 = pi 扩展注册的 `translate_task` 工具——加载模块化 prompt、调 translator 模型 API、返回结构化任务描述。不经过 subagent。

**Tech Stack:** pi SYSTEM.md + pi 扩展系统 + providers.roles.toml（模型路由）

## Global Constraints

- 人格写入 SYSTEM.md，trident skill 作为补充上下文（可后续删除）
- 翻译层以工具形态存在（pi 扩展注册），不用 subagent
- 翻译工具使用与 OC 主 agent 不同厂商的模型
- 隐私剥离规则挂在翻译工具输出端，不在 OC 人格中
- 模型路由配置不进入 git 仓库
- providers.roles.toml 格式：`provider:model`

---

### Task 1: SYSTEM.md 注入 OC Agent 人格

**Files:**
- Modify: `SYSTEM.md`

**Interfaces:**
- Produces: OC Agent 人格 + 任务路由规则 + 工具使用规范

✅ 已完成。commit `1760d95`。

---

### Task 2: 删除 translator 子 agent

**Files:**
- Delete: `agents/translator.md`

**Interfaces:**
- 无产出。清理错误设计——翻译层不应是 subagent。

✅ 已完成。等待提交。

---

### Task 3: 实现 translate_task 工具（pi 扩展）

**Files:**
- Create: `extensions/trident-translator/index.ts`
- Create: `extensions/trident-translator/package.json`（如需要）

**Interfaces:**
- Consumes: OC Agent 调用工具时传入的原始发言
- Produces: 结构化任务描述（title / goal / constraints / user_signals / context）
- 内部：读 providers.roles.toml 获取 translator 模型 → 拼装模块化 prompt → 调 LLM API → 返回结果

- [ ] **Step 1: 研究现有扩展结构作为参考**

```bash
ls ~/.pi/agent/extensions/subagent/
cat ~/.pi/agent/extensions/subagent/index.ts | head -100
```

了解 pi 扩展如何注册工具、如何调用 LLM。

- [ ] **Step 2: 编写 translate_task 工具**

扩展注册一个 `translate_task` 工具。工具描述：

```
将用户的自然语言发言翻译为结构化任务描述。内部使用 translator 角色指定的模型
（与主 agent 不同厂商），加载模块化提示词模板，进行信号检测和意图提取。
```

工具参数：
- `utterance` (string, required): 用户的原始发言

工具返回：
```json
{
  "title": "任务标题",
  "goal": "一句话目标",
  "constraints": ["约束1", "约束2"],
  "user_signals": "用户状态信号",
  "context": "原始上下文"
}
```

工具内部流程：
1. 读取 `providers.roles.toml` 获取 `translator` 模型
2. 加载模块化提示词（信号检测 + 意图提取 + 约束收集）
3. 调用 translator 模型 API
4. 隐私剥离
5. 返回结构化结果

- [ ] **Step 3: 模块化提示词内嵌**

初版不动态加载文件——将信号检测 prompt 和意图提取 prompt 直接写在扩展代码中。后续再抽成独立模块文件。

```typescript
const SIGNAL_DETECTION_PROMPT = `分析用户状态：过载/已知/拒绝/深问/低动力/高投入/焦躁/求确认`;

const INTENT_EXTRACTION_PROMPT = `从发言中提取核心任务目标、约束条件、技术栈...`;
```

- [ ] **Step 4: 隐私剥离**

在返回结果前过滤：移除角色名、个人经历、不宜公开内容的模式匹配。

- [ ] **Step 5: 验证**

手动测试：`translate_task("我那个 Go 项目的 air 配置好像有问题，帮我看看")` → 预期返回结构化任务描述。

- [ ] **Step 6: Commit**

```bash
git add extensions/trident-translator/
git commit -m "feat(trident): 实现translate_task翻译工具扩展"

# 实现细节：三叉戟Phase 1——翻译层以pi扩展工具形态实现，
# 单次LLM API调用，不占subagent资源
```

---

### Task 4: 配置模型路由

**Files:**
- Create: `providers.roles.example.toml`
- Modify: `.gitignore`

✅ 已完成。commit `cb3aadc`。`providers.roles.toml` 需用户手动创建。

---

### Task 5: 清理与提交

**Files:**
- Delete: `agents/translator.md`（Task 2 的提交）
- Modify: `SYSTEM.md`（Task 1 已完成，但需确认引用 translator 工具而非子 agent）

- [ ] **Step 1: 确认 SYSTEM.md 已更新为工具调用**

```bash
grep "translate_task" ~/.pi/agent/SYSTEM.md
```

期望：找到引用。

- [ ] **Step 2: 删除 translator 子 agent 并提交**

```bash
git add agents/translator.md  # 删除
git add SYSTEM.md
git commit -m "refactor(trident): 翻译层从subagent改为工具形态

实现细节：删除agents/translator.md，SYSTEM.md中translator引用改为translate_task工具。
翻译层作为pi扩展工具实现，单次LLM API调用，不占subagent资源"
```

- [ ] **Step 3: 隐私自检**

```bash
grep -rn -i "kimi\|nsfw\|nahida\|纳西妲\|上床\|fount\|sillytavern\|角色扮演伴侣" \
  SYSTEM.md \
  skills/clyzhi/trident/SKILL.md \
  extensions/trident-translator/ \
  docs/specs/ \
  docs/plans/
```

期望：无匹配（除泛指术语"角色扮演伴侣"和 grep 命令自身）。

---

### Task 6: 端到端验证

- [ ] **Step 1: 确认文件结构**

```bash
echo "=== 三叉戟文件 ==="
ls -la SYSTEM.md
ls -la skills/clyzhi/trident/SKILL.md
ls -la extensions/trident-translator/index.ts
ls -la providers.roles.example.toml
```

- [ ] **Step 2: 确认 gitignore 生效**

```bash
git status | grep -E "providers.roles.toml|queue/"
```

期望：无输出。

- [ ] **Step 3: 查看完整 diff**

```bash
git diff base..HEAD --stat
```
