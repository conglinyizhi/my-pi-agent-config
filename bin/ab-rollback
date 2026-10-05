#!/bin/sh
# bin/ab-rollback — 回退到上一个稳定槽（应急通道）
#
# 这里刻意只做一件事：把 current 软链指回 previous。
# 不依赖 node、不依赖 pi 扩展、不依赖 Electron——Electron 完全起不来时它也得能用，
# 这就是「A/B 更新」的安全隔离支点（见 docs/plans/2026-10-05-ab-update.md）。
set -eu

component=${1:-}
case "$component" in
  gui|audit) ;;
  *) echo "用法: ab-rollback <gui|audit>" >&2; exit 2 ;;
esac

runtime_root=${PI_RUNTIME_ROOT:-$HOME/.pi/runtime}
dir=$runtime_root/$component

if [ ! -d "$dir/previous" ]; then
  echo "没有 previous 槽，退不了：$dir/previous" >&2
  exit 1
fi

ln -sfn "$dir/previous" "$dir/current.tmp"
mv -Tf "$dir/current.tmp" "$dir/current"
printf '%s %s\n' "$(date -Iseconds)" "{\"event\":\"rollback\",\"by\":\"ab-rollback\"}" >> "$dir/promote.log"
echo "已回退：$dir/current -> $dir/previous"
