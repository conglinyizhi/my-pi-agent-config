# pi-hub

机级审批守护进程。一台机器一个，Unix socket，零 TCP 端口。

主线只在 **Linux + systemd --user + Unix socket** 上推进，这边不维护旧形态。

其他系统若还要人工审批，从 tag `pre-linux-hub` 或分支 `archive/pre-linux-hub` 自己接：当时是进程内 GUI→TUI 通道，没有机级 hub。许可窗也可以改用系统对话框（zenity / yad / kdialog），不必跟 Wails 走。

## 做什么

- 多个 pi session 连同一条 `~/.pi/agent/run/hub.sock`
- 审批扇出：本机闸门窗 + 已连接的 IM 适配器，**先合法应答赢**，输家关窗 / 改卡
- hub 没起来：pi 回退现有 GUI→TUI
- 陌生人找 bot：挡住，给一次性码；**只有本机贴码才授权**（pi 里 `/remote:allow-key`，或 `pi-hub grant`）
- 飞书适配器走本机 `lark-cli`（`hub/adapters/feishu/`）；没有 CLI 就不启
- 未公开 IM 适配器不入库，放 `hub/private/`（gitignore）

协议是 JSON 行。适配器用通用 `channel` + `userId`，hub 源码不出现具体软件名。

## 装

新机或改完代码：

```bash
~/.pi/agent/hub/install.sh           # 测、编、enable --now hub；有 lark-cli 才启飞书
~/.pi/agent/hub/install.sh --reload  # 迭代：编完 restart 已在跑的服务
~/.pi/agent/hub/install.sh --status  # 只看状态
~/.pi/agent/hub/install.sh --feishu  # 没有 CLI 也 enable 飞书 unit（缺 CLI 会 78 退出）
```

本机贴码（pi 只提供入口，窗由 hub 拉起）：

```text
/remote:allow-key PIHUB-xxxxxxxxxxxxxxxx
/remote:gui
```

`/remote:gui` 让 hub 用 yad 打开 IM 许可窗。命令行备用：`pi-hub grant`、`pi-hub list`、`pi-hub pairs`。旧 Wails 许可窗源码在 `archive/wails-allowlist/`。

覆盖 socket：`PI_HUB_SOCKET` 或 `-socket`。

## 超时

审批默认 1 小时（`-ask-ttl`）。配对码 15 分钟（`-pair-ttl`）。过期由 hub 广播 `settled`，能改消息的适配器再改卡。

## 安全

socket `0600`，Linux `SO_PEERCRED` 只接受同一 UID。白名单在 `~/.pi/agent/hub-state/allowlist.json`。IM 把码发回去不算授权。

## 许可窗 demo

许可窗用 yad（GTK，KDE 上也能跑）。本机没有 yad 时 `/remote:gui` 不可用，仍可用 `/remote:allow-key`。示意：

```bash
hub/demo-allow-dialog.sh
```
