#!/usr/bin/env bash
# 把 GUI 的图标与 desktop 条目装进用户目录。
#
# 为什么需要：Wayland 下窗口图标不走窗口属性，KDE 是按 app_id 去找 desktop 文件里的 Icon=。
# 系统里 Electron 只装了带版本号的条目（electron31.desktop …），窗口的 app_id 默认是不带
# 版本号的 electron，对不上 → 任务栏与标题栏只好交通用占位图标。给窗口自己的 app_id
# （bin/gui 传 --class=pi-gui）并装一份同名 desktop 条目，图标才认得出来。
#
# 用法：gui/install-desktop.sh        （改过图标或 desktop 条目后重跑即可）
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
icon_root="${HOME}/.local/share/icons/hicolor"
app_dir="${HOME}/.local/share/applications"

install -Dm644 "${here}/icons/pi-gui.png" "${icon_root}/512x512/apps/pi-gui.png"
install -Dm644 "${here}/icons/pi-gui-256.png" "${icon_root}/256x256/apps/pi-gui.png"
install -Dm644 "${here}/pi-gui.desktop" "${app_dir}/pi-gui.desktop"

# 缓存刷新（命令不一定在，缺了也不影响）
command -v update-desktop-database >/dev/null && update-desktop-database "${app_dir}" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t "${icon_root}" >/dev/null 2>&1 || true

echo "装好了：${app_dir}/pi-gui.desktop → Icon=pi-gui"
