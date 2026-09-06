# model-selection

提供通用的模型选择与当前 session 模型切换能力。

## 用法

```text
/model:select                 # 打开 provider → model 选择器
/model:select provider/model  # 精确切换当前 session 模型
```

模型选择能力也以 `set_session_model` 工具提供给主 agent。

重要语义：

- 只调用 pi 的 `setModel`，覆盖当前 session；
- 不修改 `settings.json` 的 `defaultModel`；
- 不影响已经启动的 subagent worker；
- 模型必须已在 registry 注册且有可用认证；
- 模型偏好记录在 `~/.pi/agent/model-selection.toml`，仅用于下次选择器的“上次选择”；旧的 `message-page-model.toml` 会兼容读取。

`gen-page-use-latest-msg` 继续支持 `--model provider/model`，并复用同一套选择器与解析逻辑。
