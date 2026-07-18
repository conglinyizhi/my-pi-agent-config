# for-grok-4-5

**强大、实惠、但疯跑的孩子。**  —— 专为 grok-4.5 两大顽疾设计的自动化补丁。

---

## 习性一：只 thinking、不吐正文就停

大模型只吐了思维链、正文去掉空白后一个字都没有时，自动续跑并发送警告通知；同时拦截「任务完成」通知。

### 触发条件

最后一条 assistant 同时满足：

1. type: text 拼起来去空白后长度为 0（含完全没有 text 块）
2. 没有 toolCall
3. 有非空 thinking，或 stopReason === "length"（截断）
4. 非用户取消（aborted）
5. 非 pi 可自动重试的网络错误（交给内置重试）
6. thinking **未**表达「已完成 / 无需再追问」（见下）

### 不续跑的收工信号（thinking 内）

满足任一则不自动追问：

- 同时包含「完成」与「简单回复」（与逻辑）
- 或包含「不要再调用工具」

### 行为

| 步骤 | 动作 |
|------|------|
| 1 | markSuppressTaskComplete()，task-notification 跳过「任务完成」 |
| 2 | TUI warning + 桌面 urgency: critical：「大模型 API 出现了异常截断输出，自动进行重试」 |
| 3 | sendUserMessage(...) 排队开启新一轮 |

连续异常截断输出最多自动续 **3** 次，超限报错并停止。

---

## 习性二：反复 true 空转不停

连续两次在 bash 中**仅**调用 true → 视为任务正常完整结束，不是出错、不是危险拦截。

### 背景

grok-4.5 收工时常反复：`bash → command: "true"`。没有正文、也不停。这是模型行为，开发者改不了模型，只能识别成正常完成信号并打断空转。

### 规则

| 事件 | 行为 |
|------|------|
| bash 且 command.trim() === "true" | 连续计数 +1，照常执行 |
| 其它工具，或 bash 非纯 true | 计数清零 |
| 计数达到 **2** | 正常完成通知 + 第二次 true 跑完后 abort 停空转 |
| 用户新输入 / 新 session | 全量复位 |

- true && true、true; ls 等不算 pure true
- 不 block 第二次 true（避免 UI 像工具报错）
- abort 只是停循环；task-notification 对 aborted 不通知，故本扩展自行 notifyTaskComplete

### 通知文案

```
任务处理完成（grok-4.5：连续 bash true 正常收工）
```

---

## 与 task-notification 协作

共享模块：lib/continuation-guard.ts

- 本扩展在 message_end（早于 agent_end）写入 suppress 标志
- task-notification 在发送完成通知前检查 shouldSuppressTaskComplete()

## 使用

扩展目录自动加载。/reload 或重启 pi 后生效。无需命令，全自动。

状态栏 key：`for-grok-4-5`
