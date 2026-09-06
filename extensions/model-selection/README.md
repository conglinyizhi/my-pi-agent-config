# model-selection

提供通用的模型选择与当前 session 模型切换能力。

## 用法

```text
/model:select-current-session-model
/model:select-current-session-model provider/model

/model:change-current-session-model provider/model
/model:switch-current-session-model provider/model
```

`/model:select` 仍作为短兼容命令保留。模型选择只通过用户主动输入的命令触发，不注册任何供模型调用的选择工具。命令名刻意包含 `model`、`select`、`current`、`session`、`change`、`switch` 等英文关键词，便于搜索。

共享文件示例：

```toml
[global]
pinned = ["cheap-provider/fast-model"]

[scopes.model-selection]
recent = ["other-provider/reasoning-model"]
pinned = ["cheap-provider/session-model"]

[scopes.message-page]
recent = ["cheap-provider/page-model"]
pinned = []
```

每个功能保存最多 4 条 `recent`，并维护自己的 `pinned`；`global.pinned` 对所有功能可见。插件接入时应给共享选择器传入稳定且唯一的 scope 名：

```ts
const selected = await selectModel(ctx, modelSpec, { scope: "my-plugin" });
if (!selected.ok) return;
const model = selected.model;
```

不要自行读写 TOML，也不要省略 scope；共享库负责确认、置顶、取消置顶、最近列表去重和原子写入。

重要语义：

- 只调用 pi 的 `setModel`，覆盖当前 session；
- 不修改 `settings.json` 的 `defaultModel`；
- 不影响已经启动的 subagent worker；
- 模型必须已在 registry 注册且有可用认证；
- 所有复用该库的插件共享 `~/.pi/agent/model-selection.toml`，但最近记录与局部置顶按功能 scope 隔离；
- 同一模型已在当前功能或全局置顶时，不会重复进入该功能的 `recent`；
- 旧的 `message-page-model.toml`、旧 `[model]`、旧 root `last/pinned` 格式会兼容读取。

`gen-page-use-latest-msg` 继续支持 `--model provider/model`，并使用独立的 `message-page` scope。普通模型的确认选项为“确认使用 / 当前功能置顶并确认 / 所有功能置顶并确认 / 取消”。选择置顶模型时，会单独询问“选择这个置顶模型 / 取消当前功能或所有功能置顶 / 返回上一级”，避免误操作。
