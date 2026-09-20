# get-clyzhi-debug-info

## 功能概述

`/get-clyzhi-debug-info`：弹一个 TUI 展示当前会话与路径，用户点同意后整段复制到剪贴板。

排查时常用：会话文件在哪、cwd 是什么、会话 ID 是多少，一次性拿全并粘出去。

## 交互

1. 确认框里展示**将要复制的内容**：

   ```
   会话 ID   01a0bcdb-1bde-7690-98a5-30dbfbf0d8f7
   会话文件  /home/dev/.pi/agent/sessions/--home-dev-project--/2026-09-20T03-27-51.jsonl
   当前路径  /home/dev/project
   ```

2. 同意 → 复制；取消 → 什么都不做（**不会静默复制**）
3. 复制结果分三种结局报，不合并：
   - 本地工具写成功 → info，带上工具名
   - 只发出 OSC 52 兜底 → warning。序列发出去了，但终端认不认由终端决定，**不能报成「已复制」**
   - 全部失败 → warning，逐条列出通道与原因

   后两种会把原文附在提示里，用户至少能手动复制，不至于白跑一趟。

## 依赖

- `lib/clipboard.ts` — 跨平台剪贴板。平台路由、wl-copy 的 daemon 坑、remote 会话的 OSC 52 兜底都在那边，本插件不重复实现
- `lib/clipboard.ts` 的 `describeClipboardResult` — 把一次复制结果翻成给用户看的一句话（三种结局的判断也收在 lib 里，免得每个调用方各写一遍）

## 设计要点

- **展示的与复制的是同一份**：都来自 `debugInfoLines()` 的输出，不会出现「看到的是 A、复制的是 B」
- **标签列按显示宽度对齐**：CJK 在字符串里算 1 个字符、屏幕上占 2 列。用普通空格补，会在「会话 ID」这种中英混排的标签上错位（`会话 ID` 是 7 列，`会话文件` 是 8 列）
- **没有 UI 就不复制**：这个命令的价值就在「用户看过再复制」，静默复制不算达成目的
- **回退不假装成功**：OSC 52 与「全失败」都把原文附上，不靠提示文字掩盖没写进去的事实

## 测试

```bash
node --test extensions/get-clyzhi-debug-info/smoke.test.ts   # 9 条：信息行、对齐、四种流程分支
node --experimental-strip-types lib/clipboard.test.ts        # 含 describeClipboardResult 三条
```

冒烟测试注入 `copy`，不会 spawn 真的剪贴板工具；真机剪贴板路径由 `lib/clipboard.test.ts` 覆盖。
