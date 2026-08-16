# DSH 迁移 A/B 验收清单

> 状态：待执行 | 日期：2026-08-15
> 目的：五个提交（`e2cd6df`…`1cb827c`）全部只过了单测与 mock，**从未在真实 pi 会话运行**。
> 本清单是「移植完成 → 确认有效」的临门一脚。对照基准：`v0.1.0` tag。

## 0. 前置

```bash
git tag                                # 确认 v0.1.0 在
pi                                     # 启动，观察扩展加载无报错（Extensions 列表应含 4 个新扩展）
```

开关现状（settings.json，均默认值）：
| 开关 | 默认 | 含义 |
|---|---|---|
| `promptSections` | **true**（已进 tracked） | 有序段装配 |
| `dshTodo` / `dshStrReplaceEditor` / `dshJobs` | true | 对应工具集 |
| `dshGoal` | **false** | 与旧 `/goal` A/B，启用前先想好停用哪个 |

## 1. Track A：prompt-sections

### 1.1 关闭态回归（对照 v0.1.0）
1. `/prompt-sections off` → `/sysprompt` 导出 → 与 `v0.1.0` 行为对比：**应逐字节一致**（各扩展回退到旧注入路径）
2. 跑一个普通对话，确认 plan-mode / skill-kit / 母港行为与 v0.1.0 无异

### 1.2 开启态
1. `/prompt-sections on` → `/prompt-sections-preview`：装配段序应为
   `pi:default → tool-guidance:skill-triggers → tool-guidance:tool-checker`（无 plan-mode 段时）
2. `/plan` 进入计划模式 → preview 应出现 `policy:plan-mode`（order 50，位于默认提示词之后）
3. 母港 `/homeport` → preview 应只剩 `persona:homeport`（complete 段替换一切）
4. `/sysprompt` 对比开启前后的长度与结构

### 1.3 交互风险点（mock 测不出的，重点盯）
- **skill-kit 文本变换**：其 handler 的占位符替换/技能过滤作用于装配结果——确认 trigger 表**不重复**（段 + 追加同时出现 = 双重注入）
- **母港 complete 段**：进母港时装配只剩母港提示词；确认 skill-kit 等下游变换没有破坏它
- **plan-mode 段切换**：计划→执行→关闭三态下段出现/消失正确，`[DONE:n]` 追踪不受影响

## 2. Track B：dsh-tools

### 2.1 todo_write
1. 对话里让模型做多步任务 → 观察是否调用 `todo_write`（全量列表）
2. `/dsh-todos` 应显示最后快照
3. `/resume` 后 `/dsh-todos` 仍能折叠出（appendEntry 持久化）

### 2.2 str_replace_editor
1. 让模型用 `view` 看文件（应带行号）→ `insert` 按行插入 → `str_replace` 精确替换
2. 故意给不唯一的 `old_str` → 应拒绝执行并给行号
3. 与 `edit` 共存：确认模型能正确二选一（看 promptGuidelines 是否生效）

## 3. Track B：dsh-goal

1. settings.json 加 `"dshGoal": true`，`/reload`
2. `/dsh-goal 帮我完成 X` → 应创建并 armed
3. 观察自动续行：每轮结束 agent_settled → `<goal_round Round: n/max>` 注入 → 模型继续
4. 完成后模型调 `update_goal(complete)` → 续行停止
5. `/resume` 重开 → `/dsh-goal status` 目标还在但 **disarmed** → `/dsh-goal resume` 重新武装
6. 故意让模型在**非人类轮**调 `create_goal` → 应被权限拒绝
7. 与旧 `/goal` 并存验证：同一会话别同时激活两者（两个续行循环会打架）

## 4. Track B：dsh-jobs

1. 让模型 `bash_background("sleep 5; echo hi")` → 返回 job id，轮次不阻塞
2. `job_output(job_id, wait: true)` → 阻塞到完成，输出 hi，`[status: completed (exit code: 0)]`
3. 完成时应有桌面/状态通知（wakeup：agent 空闲则开新轮次通知模型）
4. `bash_background("sleep 30")` → `job_kill(job_id)` → `[status: killed (killed by SIGTERM)]`
5. `/dsh-jobs` 列表正确
6. **风险点**：wakeup 通知开新轮次——确认不会因「任务完成→通知→模型读→(无新任务)→正常停」形成循环；`quiet` 模式（`dshJobsDelivery: "quiet"`）作为对照

## 5. 量化对比（可选）

用 trident-subagent 的 usage 统计或模型响应观察：
- 同一任务在开关开/关各跑一遍 → 对比 input tokens / cost / cacheRead
- 关注 prompt-sections 的 KV 缓存纪律：稳定段在前、动态内容（cwd）在尾

## 6. 结论记录

每项标记 ✅/❌ + 截图或 /sysprompt 导出；❌ 项回到对应扩展修。全部 ✅ 后：
- 考虑 `dshGoal` 是否转默认开（需先决定旧 `/goal` 去留）
- 删除本清单或归档到 docs/plans/done/
