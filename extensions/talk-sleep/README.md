# talk-sleep

## 功能概述

暂存当前对话并在后续恢复。类似于「书签」功能，将当前 session 信息（ID、路径、工作目录、备注）存入 `~/.pi/talk-sleep.jsonl`，后续可通过 TUI 选择器找回并复制恢复指令。

## 提供的命令

### `/talk-sleep [备注]`

将当前对话暂存。自动记录 sessionId、sessionFile、cwd 和时间戳。仅在 session 已持久化时才可暂存（in-memory session 不支持）。

备注**必填**：命令行没带备注时会弹输入框索取；Esc 或空输入则放弃暂存，不写入记录。备注会统一压成单行（换行/制表符会撑破列表排版，也会破坏恢复指令里的 `# 备注`）。

### `/talk-sleep-load`

弹出 TUI 选择器，展示所有暂存对话（按时间倒序），选中后可选：

- **复制恢复指令到剪贴板**（`cd <cwd> && pi --session <id>  # <备注>`）
- **仅显示恢复指令**
- **编辑备注** — 打开多行编辑器改备注（Esc 取消则原样保留，清空则删除备注）；改完自动回到动作菜单，可以直接接着复制
- **取消**

编辑是就地改写：只替换目标记录那一行，其余行（包括解析不了的行）原样保留；先写临时文件再 rename，避免写坏暂存文件。

剪贴板走共享模块 `lib/clipboard.ts`，先按环境路由本地工具，不做无脑盲试：macOS → `pbcopy`；Windows → `clip`；Termux → `termux-clipboard-set`；Wayland → `wl-copy`（失败且存在 `DISPLAY` 再回落 `xclip` → `xsel`）；仅有 `DISPLAY` → `xclip` → `xsel`。文本只经 stdin 写入（不拼 shell 命令，也不会像 `echo … | xclip` 那样多出一个尾换行），通道退出码为 0 才算成功。本地通道全失败、或处于 SSH/mosh 会话时，额外发一次 OSC 52 转义序列，由终端自己写入宿主剪贴板（base64 超 100000 字符则放弃）。

## 排版

列表按 `备注 │ cwd │ 时间` 三列展示，备注列按终端单元格宽度补齐/截断（CJK 与 emoji 算 2 格），列宽取本次列表里最长备注的宽度，钳在 8–28 之间。备注长短不会再让 cwd 和时间错位；超长备注截断加 `…`。

同一毫秒、同一 cwd、同一备注生成的两行会完全一样，选择器靠 `indexOf` 定位会选错目标，所以重复行末尾自动补 `#2`、`#3` 区分。

## 数据存储

`~/.pi/talk-sleep.jsonl`：每行一个 JSON 对象：
```json
{"sessionId":"...","sessionFile":"...","cwd":"...","note":"备注","timestamp":"..."}
```

## 测试

```bash
node --experimental-strip-types extensions/talk-sleep/smoke.test.ts
```

用假 HOME 跑（`/tmp/talk-sleep-smoke`），不碰真实暂存文件。

## 依赖

- Node.js fs/promises（剪贴板实现见共享模块 `lib/clipboard.ts`）
- `@earendil-works/pi-coding-agent` — ExtensionAPI
