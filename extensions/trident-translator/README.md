# trident-translator

`translate_task`：用 `providers.roles.toml` 的 `translator` 模型，把用户原话收成结构化任务描述。

## 调用约束

- `--no-tools` / `--no-extensions` / `--no-skills` / `--no-prompt-templates` / `--no-context-files`
- `--thinking off`
- `--mode json` 后解析事件流，只返回最终 assistant 文本
- `PI_SUBAGENT=1` 时不注册工具，避免递归

## 输出字段

`title` / `goal` / `constraints` / `user_signals` / `context`

## 配置

```toml
[roles]
translator = "provider/model"
```
