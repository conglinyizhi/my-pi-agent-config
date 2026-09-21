# GUI 回退 TUI：原因与修复

这份文档**不被 pi 的 skill 扫描发现**（子目录里的非 `SKILL.md` 文件），
只做一件事：当审批 / 提问 / GUI 命令退回终端时，告诉你为什么、怎么修。

看到这条路径，通常意味着刚才那一下没走图形界面。下面按「谁在链路上 → 什么现象 → 怎么查 → 怎么修」排。

## 回退链

审批（bash / sandbox-allow / capability）走三层，前面不通就退后面：

1. **本机 hub**：`~/.pi/agent/run/hub.sock`，连接超时 400ms。可用 `PI_HUB_SOCKET` 覆盖
2. **本机 Wails 窗**：`lib/gui-runner.ts` 的 `findGuiBinary()`，两个候选位
   - `~/.pi/agent/bin/wails-gui`（首选安装位）
   - `~/.pi/agent/wails-gui/build/bin/wails-gui`（仓库构建位，`wails build` 的默认输出）
3. **终端 TUI**：`ctx.ui.select` 弹一个「允许 / 拒绝」

提问（`ask_question`）是另一条：hub 发出去之后本地 TUI 同时开着，**先答的算**。
hub 那头没人能答（没适配器在线）才算回退，用户拒绝不算。

## 现象 → 原因 → 修复

| 现象 | 原因 | 查 | 修 |
|---|---|---|---|
| 提示「连不上本机审批 hub」 | `pi-hub.service` 没起来 / socket 不在 | `systemctl --user status pi-hub.service`；`ls -l ~/.pi/agent/run/hub.sock` | `~/.pi/agent/hub/install.sh`（迭代用 `--reload`） |
| 提示「没找到 wails-gui 二进制」 | 两个候选位都没有可执行文件 | `ls -l ~/.pi/agent/bin/wails-gui ~/.pi/agent/wails-gui/build/bin/wails-gui` | 见下方「构建」 |
| 提示「存在但进程起不来」 | 文件没有 `+x`，或缺 WebKitGTK 动态库 | `file <bin>`；`ldd <bin> \| grep -i "not found"` | `chmod +x <bin>`；Arch 上 `sudo pacman -S webkit2gtk-4.1` |
| 提示「窗口启动后直接退出」 | 前端资源没打进二进制 / 运行时崩 | 在终端手动跑一次：`~/.pi/agent/wails-gui/build/bin/wails-gui gate /tmp/req.json /tmp/resp.json` | 重构建（改了 `frontend/src/**` 必须重建，前端是内嵌的） |
| 提示「窗口没有在时限内给出结果」 | 窗口被挡在别的虚拟桌面 / 没有图形会话 | `echo $DISPLAY $WAYLAND_DISPLAY` | 在图形会话里跑；或直接 `/remote:allow-key` 走 IM |
| 提示「hub 在跑，但本机 GUI 和 IM 适配器都不在线」 | hub 拉不起本机窗，又没有适配器在线 | `journalctl --user -u pi-hub \| tail`；找 `gate gui:` 那行 | 修本机 GUI（构建），或接适配器（见「IM 适配器」） |
| `/remote:gui` 不可用 | 没装 `yad` | `command -v yad` | 装 yad（GTK），或改用 `/remote:allow-key <码>` |

## 构建 wails-gui

```bash
cd ~/.pi/agent/wails-gui
wails build -tags webkit2_41
# 输出在 build/bin/wails-gui，findGuiBinary() 直接能找到，不装到别处也行
```

- **`-tags webkit2_41` 不能省**：Arch 上 webkit2gtk-4.0 那条链已断，漏了会链接失败，
  报错特征是 `undefined reference to Jxl*`。
- 没有 wails CLI：`go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- 依赖自检：`wails doctor`
- 前端源码在 `wails-gui/frontend/src/**`，改完必须重跑 `wails build`，否则跑的是旧 UI。

开发规范（窗口名映射、目录结构、浏览器 mock shell）见 skill：`skills/clyzhi/gui-standards/SKILL.md`。

## hub

```bash
~/.pi/agent/hub/install.sh           # 测、编、enable --now
~/.pi/agent/hub/install.sh --reload  # 迭代：编完 restart
~/.pi/agent/hub/install.sh --status  # 只看状态
```

两个已知坑（细节见 `hub/README.md`）：

- unit 里**不能**写 `After=default.target`（和 `WantedBy=default.target` 凑成自指环，开机时 systemd 会删掉飞书那条 start job）
- hub 比图形会话的环境导入早，自己拿不到 `DISPLAY` / `WAYLAND_DISPLAY`，
  由 `hub/sessionenv.go` 从 `systemctl --user show-environment` 补。
  journal 里找「会话环境缺失，已从 systemd 补入」。

## IM 适配器（hub 在线但没人能答时）

```bash
pnpm add -g @larksuite/cli
lark-cli config init
lark-cli auth login
systemctl --user start pi-hub-feishu.service
```

飞书适配器只是包本机 `lark-cli`；没有 CLI 时进程以 78 退出、不再重启（不是崩溃）。

## 贴码 / 许可窗

```text
/remote:allow-key PIHUB-xxxxxxxxxxxxxxxx
/remote:gui
```

命令行备用：`pi-hub grant` / `pi-hub list` / `pi-hub pairs`。

## 相关文件

```text
lib/gui-runner.ts              GUI 启动器（runGuiWindow / launchGuiWindow / findGuiBinary）
lib/gui-diagnosis.ts           回退原因诊断 + 修复建议文本（上面这些提示的来源）
lib/hub-channel.ts             hub 通道；连不上 → 回退本地
lib/approval-channel.ts        审批通道；GUI 失败 → TUI select
extensions/ask-question/       提问：hub 与本地 TUI 并行
wails-gui/                     Wails 单二进制（gate / routing / editor / subagents 四个窗口）
hub/                           机级审批守护（socket、扇出、配对码）
```
