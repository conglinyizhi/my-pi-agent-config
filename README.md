# Pi 快速部署指南

> 这个文档是 kimi code + kimi-k2.7-code 编写

Pi 是一个极简的终端编程助手，可通过 pnpm 或一键脚本快速安装到本地。

## 1. 安装

### 方式一：pnpm（推荐）

```bash
pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 用于禁用依赖生命周期脚本，Pi 正常安装不需要执行这些脚本。

### 方式二：一键脚本

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

### 方式三：其他包管理器

```bash
# npm
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Yarn
yarn global add @earendil-works/pi-coding-agent

# Bun
bun add -g @earendil-works/pi-coding-agent
```

## 2. 认证

Pi 支持两种认证方式：订阅登录 或 API Key。

### 方式一：订阅登录

启动 Pi 后输入：

```text
/login
```

按提示选择服务商，支持 Claude Pro/Max、ChatGPT Plus/Pro（Codex）、GitHub Copilot 等。

### 方式二：API Key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

也支持通过 `/login` 选择 API Key 服务商并保存到 `~/.pi/agent/auth.json`。

> 完整支持列表参见 [Pi Providers 文档](https://pi.dev/docs/providers)。

## 3. 启动并使用

进入你想要处理的项目目录，直接运行：

```bash
cd /path/to/project
pi
```

启动后输入你的需求，例如：

```text
Summarize this repository and tell me how to run its checks.
```

## 4. 常用命令

| 命令                      | 说明                       |
| ------------------------- | -------------------------- |
| `pi -c`                   | 继续最近一次的会话         |
| `pi -r`                   | 浏览并选择历史会话         |
| `pi -p "你的问题"`        | 非交互模式，输出结果后退出 |
| `pi --name "任务名"`      | 给当前会话命名             |
| `pi @文件路径 "你的问题"` | 将指定文件作为上下文传入   |

## 5. 给项目添加说明

Pi 启动时会自动加载 `AGENTS.md`（或 `CLAUDE.md`）作为项目上下文。在项目根目录创建 `AGENTS.md`：

```markdown
# Project Instructions

- 代码改动后运行 `pnpm check`。
- 不要在本地执行生产环境迁移。
- 保持回复简洁。
```

修改后重启 Pi 或执行 `/reload` 生效。

## 6. 卸载

```bash
# pnpm
pnpm remove -g @earendil-works/pi-coding-agent

# npm / curl 安装
npm uninstall -g @earendil-works/pi-coding-agent

# Yarn
yarn global remove @earendil-works/pi-coding-agent

# Bun
bun uninstall -g @earendil-works/pi-coding-agent
```

> 卸载后，`~/.pi/agent/` 中的设置、凭据、会话和已安装的 Pi 包不会自动删除。

## 参考

- [Pi 官方文档](https://pi.dev/docs)
- [Pi GitHub](https://github.com/openclaw/pi)
