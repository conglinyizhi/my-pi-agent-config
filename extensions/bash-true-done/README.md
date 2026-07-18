# bash-true-done

**grok-4.5 特性（应用侧无可奈何的适配）**：连续两次在 bash 中**仅**调用 `true` → **视为任务正常完整结束**，不是出错、不是危险拦截。

## 为什么

`grok-4.5` 收工时常反复：

```text
bash → command: "true"
```

没有正文、也不停。这是模型行为，开发者改不了模型，只能识别成**正常完成信号**并打断空转。

历史 session 里可见连续 2～9 次 pure `true`。

## 规则

| 事件 | 行为 |
|------|------|
| `bash` 且 `command.trim() === "true"` | 连续计数 +1，**照常执行** |
| 其它工具，或 bash 非纯 `true` | 计数清零 |
| 计数达到 **2** | **正常完成**通知 + 第二次 true 跑完后 `abort` 停空转 |
| 用户新输入 / 新 session | 全量复位 |

- `true && true`、`true; ls` 等**不算** pure true  
- **不** `block` 第二次 true（避免 UI 像工具报错）  
- `abort` 只是停循环；`task-notification` 对 `aborted` 不通知，故本扩展自行 `notifyTaskComplete`

## 通知文案

```text
任务处理完成（grok-4.5：连续 bash true 正常收工）
```

## 与其它扩展

- 独立于 `thinking-only-continue`（异常截断输出续跑）
- 不依赖模型 id 过滤；文案标明 grok-4.5

## 使用

`/reload` 或重启 pi。无命令，全自动。
