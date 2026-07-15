# bash-true-done

**grok-4.5 特性**：连续两次在 bash 中**仅**调用 `true`（无其它指令）→ 视为任务已正常完整结束。

## 背景

`grok-4.5` 常在收工后反复：

```text
bash → command: "true"
```

没有正文、也不停，浪费回合。历史 session 里可见连续 2～9 次 pure `true`。

## 规则

| 事件 | 行为 |
|------|------|
| `bash` 且 `command.trim() === "true"` | 连续计数 +1 |
| 其它工具，或 bash 非纯 `true` | 计数清零 |
| 计数达到 **2** | 任务完成通知 + block 本次 true + `abort` agent |
| 用户新输入 / 新 session | 全量复位 |

`true && true`、`true; ls` 等**不算** pure true。

## 通知文案

```text
任务处理完成（grok-4.5 完成信号：连续 bash true）
```

桌面通知走 `notifyTaskComplete`；随后 `abort`，因此 `task-notification` 不会因 `aborted` 再发一枪。

## 与其它扩展

- **独立**于 `thinking-only-continue`（空正文续跑）
- 不依赖模型 id 过滤：逻辑通用，文案标明 grok-4.5 特性

## 使用

`/reload` 或重启 pi。无命令，全自动。
