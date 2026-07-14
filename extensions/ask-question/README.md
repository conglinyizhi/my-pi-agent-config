# ask_question

## 功能概述

向用户发起结构化提问的工具（命名对齐 HF 社区 `ASK_QUESTION` 动作）。支持单个问题（简单选项列表）和多个问题（标签页导航切换）。是 LLM 与用户交互的主要结构化输入通道。

## 提供的工具

### `ask_question` 工具

参数：
- `questions`: Question[] — 问题数组，每个问题包含：
  - `id`: 唯一标识
  - `label`: 标签页短标题（多问题时显示）
  - `question_text`: 完整问题文本
  - `options`: 选项数组（value + label + description?，至少 1 项，建议 2–6 个）
  - `allowOther`: 是否允许自由输入（默认 true）

## 交互设计

- **单问题**：直接展示选项列表
- **多问题**：标签页导航（Tab 切换），右下角显示进度
- **键盘导航**：↑↓ 选选项，Tab/Shift+Tab 切问题，Enter 确认
- **自由输入**：选中「其他」后进入编辑器模式（支持多行）
- **外部通知**：通过 `notify-send` 发送桌面通知
- **结果回显**：答案结果中带回完整 `question_text`，便于事后在对话流中回看

## 架构

### 关键设计

- **组件化**：问题列表、选项选择器、自由输入编辑器
- **主题感知**：响应暗色/亮色主题切换
- **多行编辑器**：「其他」选项激活编辑器模式，Enter 发送，Alt+Enter 换行
- **进度显示**：多问题时显示 `问题 X/N`
- **默认选择**：自动聚焦第一个选项

### 依赖

- `../lib/notify-send` — 桌面通知
- `@earendil-works/pi-tui` — Editor, Key, Text, TUI 组件
- `typebox` — 参数类型定义
