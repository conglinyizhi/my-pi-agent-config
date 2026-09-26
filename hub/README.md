# pi-hub

机级审批守护进程。一台机器一个，Unix socket，零 TCP 端口。

主线只在 **Linux + systemd --user + Unix socket** 上推进，这边不维护旧形态。

其他系统若还要人工审批，从 tag `pre-linux-hub` 自己接（没有归档分支，`git checkout pre-linux-hub` 看）：当时是进程内 GUI→TUI 通道，没有机级 hub。许可窗也可以改用系统对话框（zenity / yad / kdialog），不必跟 Wails 走。

## 做什么

- 多个 pi session 连同一条 `~/.pi/agent/run/hub.sock`
- 审批扇出：本机闸门窗 + 已连接的 IM 适配器，**先合法应答赢**，输家关窗 / 改卡
- hub 没起来：pi 回退现有 GUI→TUI
- 陌生人找 bot：挡住，给一次性码；**只有本机贴码才授权**（pi 里 `/remote:allow-key`，或 `pi-hub grant`）
- 审批卡推给谁由 hub 的授权名单决定，随 `ask` 事件一起下发。适配器不需要账号先跟 bot 说过话，也不用自己的内存表（一重启就空）
- 飞书适配器走本机 `lark-cli`（`hub/adapters/feishu/`）；没有 CLI 就不启。决策卡默认压 2 分钟再推（`-card-delay`），期间本机窗 / 本地 TUI 已答就撤单，见该目录 README
- 未公开 IM 适配器不入库，放 `hub/private/`（gitignore）

协议是 JSON 行。适配器用通用 `channel` + `userId`，hub 源码不出现具体软件名。

## 在场信号

适配器推卡前可以问一次「用户还在电脑前吗」：`presence` → `presence-ok {idleMs, hasInput}`（只对 `adapter` 角色开放）。
hub 从启动起就监听 `/dev/input` 上的键盘与鼠标，只把 **EV_KEY 且按下**（`value != 0`）算作用户活动：鼠标漂移会一直发 EV_REL，把它算进来这个信号就永远显示「刚活动过」。
`idleMs` 是距最后一次按键的毫秒数；hub 启动后从未收到过活动时以启动时刻为基准，不会返回 0 假装刚有人按过键。`hasInput` 表示是否真有打开成功的键鼠设备。
设备表 30 秒重扫一次，热插拔的键鼠会被重新挂上；读设备要用户在 `input` 组，读不到就报 `hasInput=false`，调用方据此保守处理。

`decide` 会收到一条 `decide-ok` 回执（适配器那边是按 RPC 等的，等不到就要干耗到超时）；`settled` 另走广播，两者不混。`decide` 可以带通用 `answers`（结构化应答，hub 不解释内容，原样透传进 `settled`），提问类审批靠它回传；`decide` / 本机闸门窗响应还可以带 `writePaths`（用户在窗口里编辑后的执行范围），同样原样透传进 `settled`，由 pi 侧自己归一化与护栅；两个字段都是可选的，不带就不出现在 `settled` 里。`ask-ok` 会报当前在线适配器数，pi 据此决定要不要立刻回退本地 TUI。

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

## systemd 两处坑

hub 由 `default.target` 拉起，比图形会话导入环境要早，这两件事都得当心：

1. **unit 里别写 `After=default.target`。** 凡 `WantedBy=default.target` 的单元，systemd 都隐含 `Before=default.target`；自己再写一条 `After=default.target` 就成了自指，再叠上飞书适配器的 `After=`+`Requires=`，会凑成
   `default.target → pi-hub → pi-hub-feishu → default.target`。
   开机时 systemd 为了破环会**删掉飞书那条 start job**：unit 停在 enabled 却没 active，于是 pi 每次开会话弹一次「飞书通道需要 lark-cli」——那句话跟 CLI 装没装无关。要等图形会话就写 `After=graphical-session.target`。
2. **hub 拿不到 `DISPLAY` / `WAYLAND_DISPLAY`。** 本机实测 hub 比环境导入早约 20 秒起来，`After=graphical-session.target` 治不了这个：开机时 `graphical-session.target` 常常不在 `default.target` 那个事务里，`After=` 指向不在同一事务的 unit 等于空转。所以 hub 在拉 `wails-gui` / `yad` 之前，自己向 `systemctl --user show-environment` 要一次当前会话环境，只补白名单里的显示变量（`sessionenv.go`）。journal 里出现「会话环境缺失，已从 systemd 补入」就是这个路径在干活。

## 超时

审批默认 1 小时（`-ask-ttl`）。配对码 15 分钟（`-pair-ttl`）。过期由 hub 广播 `settled`，能改消息的适配器再改卡。

## 安全

socket `0600`，Linux `SO_PEERCRED` 只接受同一 UID。白名单在 `~/.pi/agent/hub-state/allowlist.json`。IM 把码发回去不算授权。

## 许可窗 demo

许可窗用 yad（GTK，KDE 上也能跑）。本机没有 yad 时 `/remote:gui` 不可用，仍可用 `/remote:allow-key`。示意：

```bash
hub/demo-allow-dialog.sh
```
