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
| 3 | sendUserMessage(续跑消息) 排队开启新一轮 |

连续异常截断输出最多自动续 **3** 次，超限报错并停止。

### 续跑消息的形状

```
<出口指令：请把完成详情写进 content；若又收到这条消息，就调 bash 执行 echo job done already>

<很长一段高熵随机中英混合词>
```

- 空行后面那段**不传递信息**，只用意外性把在思维链里疯狂打转的模型拽回正常输出（实测有效）。
- 空行是必须的分界：让模型自己看得出「前半是有价值的信息、后半是填充」。退化成连排，出口指令会被一起当成噪声。
- 填充**每次重新生成**，长度见 `lib/continuation-message.ts` 的 `DEFAULT_FILLER_CHARS`（越长打断越强，token 成本越高）。
- 词种用跨域词池而非随机码位：随机码位会落到生僻字/未分配区，部分 tokenizer 会退化成字节回退。

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

### 快速通道：模型直接报完成

续跑消息里告诉了模型：若又收到这条消息，就调 bash 执行 `echo job done already`。
识别用的是 `isBashHitCommand`——**只认整条命令就是哨兵本身**（容忍首尾/内部空白、
参数带引号、结尾一个分号）。

不能用 `cmd.includes(哨兵)` 子串匹配：那样任何**提到过**这句话的命令都会被当成
模型报完成，例如

- 跑一段正文里含该字面量的脚本（heredoc / python / sh）
- `grep -rn "<哨兵>" lib/`
- `<哨兵> && ls`、`<哨兵>` 后跟第二条命令

子串匹配的后果不是“多报一次完成”那么轻：它会直接 `abort()` 掉正在进行的工作，
把操作者的当前任务打断。另：哨兵命令如果本身被沙箱/规则拦下（tool_result isError），
也不算报完成——那只是工具报错。

### 通知文案

```
任务处理完成（grok-4.5：连续 bash true 正常收工）
```

---

## 与 task-notification 协作

共享模块：lib/continuation-guard.ts

- 本扩展在 message_end（早于 agent_end）写入 suppress 标志
- task-notification 在发送完成通知前检查 shouldSuppressTaskComplete()

续跑消息（含填充与哨兵）定义在 lib/continuation-message.ts，与本扩展同源：
消息里叫模型执行什么，工具拦截侧就只认那一条。

## 使用

扩展目录自动加载。/reload 或重启 pi 后生效。无需命令，全自动。

状态栏 key：`for-grok-4-5`
