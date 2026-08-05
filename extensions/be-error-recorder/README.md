# be-error-recorder

反馈模式下 subagent worker 的 `be-*` 工具（better-edit-tools 系列）调用失败时，
向 `~/.pi/subagent-be-errors.jsonl` 追加一行 JSON 记录，供离线审阅。

## 记录内容

每条记录包含：

- `ts`：ISO 时间戳
- `taskId`：批次-序号（来自 `PI_TASK_ID` 环境变量）
- `model`：worker 模型（`PI_MODEL`）
- `tool`：工具名（如 `be-read`）
- `input`：参数 JSON（截断到 2000 字符）
- `error`：错误文本（截断到 2000 字符）

## 行为约定

- **只追加**：绝不自动删除、压缩、去重或改写文件。
- 文件由用户手动编辑（清空、修复、删除皆由用户决定）。
- 记录失败静默忽略，不打断 worker。
- 日志位于 `~/.pi/`（不进项目 git 仓库）。

## 加载方式

不注册任何工具，仅由反馈模式 worker 显式加载：

```bash
pi --extension ~/.pi/agent/extensions/be-error-recorder/index.ts ...
```

## 测试

```bash
node --test extensions/be-error-recorder/be-error-recorder.test.mjs
```
