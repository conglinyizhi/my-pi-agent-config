#!/bin/sh
# pi GUI 启动器 —— Electron 宿主
#
# 协议与 Wails 版完全一致，所以 hub 与 lib/gui-runner.ts 只换可执行文件：
#   gui <windowName> <requestFile> <responseFile>
#
# 用系统装的 electron（Arch 上是 /usr/bin/electron），没有编译步骤，
# devtools（F12 / Ctrl+Shift+I）随时可用。
#
# 可调：
#   PI_GUI_ELECTRON        指定 electron 二进制（缺省走 PATH 里的 electron）
#   PI_GUI_ELECTRON_ARGS   追加 Chromium 参数。受限命名空间（容器/沙箱）里
#                           Chromium 起不来时会报 "Failed to move to new namespace"，
#                           那种场合给 --no-sandbox
set -e

agent_dir=$(cd "$(dirname "$0")/.." && pwd)

# GUI 也是可切换的组件：槽在就用槽里那份。main.js 按自己的位置找 frontend/dist，
# 所以槽是自包含的；槽不在、current 没指、或指到的地方不对，就用仓库这份——
# 与审核侧薄壳同一套退路，切换与回退都不需要改这个文件。
gui_root=${PI_RUNTIME_ROOT:-$HOME/.pi/runtime}/gui
gui_entry=$agent_dir/gui/electron/main.js
gui_init=$agent_dir/gui/electron/init-data.js
# 新模型优先：一条产品线一个 tag，生效的是 tag/dir 指的那份
gui_dir=""
if [ -s "$gui_root/tag" ] && [ -s "$gui_root/dir" ]; then
  sub=$(head -1 "$gui_root/dir")
  if [ -n "$sub" ] && [ -f "$gui_root/$sub/gui/electron/main.js" ]; then
    gui_dir="$gui_root/$sub"
  fi
fi
if [ -n "$gui_dir" ]; then
  gui_entry=$gui_dir/gui/electron/main.js
  gui_init=$gui_dir/gui/electron/init-data.js
fi

# --spec：自报能力（协议版本 / 窗口清单 / 认得哪些字段）。
# 刻意不拉起 Electron：只是为了问 init-data.js 一句话，起 Electron 又慢又多一条崩溃路径。
# 问的是 gui_init：跟着槽走，报的必须是"实际会跑的那份"。
if [ "${1:-}" = "--spec" ]; then
  # 用 stdout.write 而不是 console.log：这是程序输出（一行 JSON 给调用方解析），不是日志
  exec node --input-type=module -e "import('$gui_init').then((m) => process.stdout.write(JSON.stringify(m.buildSpec()) + String.fromCharCode(10)))"
fi

electron_bin=${PI_GUI_ELECTRON:-electron}

# app_id 与 gui/pi-gui.desktop 同名，图标才认得出来（KDE Wayland 按 app_id 找 desktop 文件）
app_id=${PI_GUI_APP_ID:-pi-gui}

exec "$electron_bin" ${PI_GUI_ELECTRON_ARGS:-} "--class=$app_id" "$gui_entry" "$@"
