# tool-checker

## 功能概述

在会话启动时检测宿主机上是否安装并配置了常用的外部 CLI 工具（如 gh、docker、git 等）。若已可用，则在系统提示词中注入指引，让大模型优先使用 CLI 而不是直接调 API。

## TUI 状态栏

实时颜色标识各工具状态：

- 绿色 ✓ — 已安装且鉴权完成
- 橙色 ⚠ — 已安装但未鉴权
- 灰色 ✗ — 未安装

## 提供的命令

### `/show-status`

查看所有外部 CLI 工具的详细检测结果。命令消息不流入 LLM 上下文。

## 架构

### 文件结构

```
tool-checker/
├── index.ts     # 主入口：声明式检测器生成、事件钩子
├── types.ts     # 类型定义（Detector, DetectorResult）
├── tools.toml   # 声明式配置，新增工具只需编辑此文件
└── README.md    # 本文件
```

### 声明式配置（tools.toml）

每个工具只需定义：
- `name` / `display` — 标识和显示名
- `check` — 检测命令（如 `gh --version`）
- `auth` — 鉴权命令（可选，如 `gh auth status`）
- `version` — 版本号正则提取（可选）
- `hint` — 注入到系统提示词的指引文本

### 执行流程

1. **session_start**：`startChecks()` 并行执行所有检测器，不阻塞会话初始化
2. 检测完成后：异步更新 TUI 状态栏（`.then()` 回调）
3. **before_agent_start**：`ensureChecksDone()` 等待检测完成 → `buildPromptAppend()` 注入提示词
4. **session_shutdown**：清理状态栏

### 关键设计

- **声明式**：新增工具只需编辑 tools.toml，无需改代码
- **非阻塞**：检测异步执行，不延迟会话启动
- **容错**：单个检测器失败不影响其他检测器
- **缓存**：检测结果缓存在会话级别，before_agent_start 只读取缓存
- **提示词注入**：只有 installed=true 且有 promptHint 的工具才注入系统提示词

### 依赖

- `smol-toml` — TOML 解析
- `@earendil-works/pi-coding-agent` — ExtensionAPI
