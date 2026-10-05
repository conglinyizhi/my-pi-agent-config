#!/bin/sh
# bin/ab-pack — 把一个 git ref 构建到槽里（ab-pack <audit|gui> [--ref <tag|sha|HEAD>] [--slot dev|head]）
#
# 薄壳：真正干活的是 scripts/ab-pack.ts。
# 提醒：打包取的是 git ref，所以改完要先提交再打包，否则槽里还是上一版。
set -eu
agent_dir=$(cd "$(dirname "$0")/.." && pwd)
exec node --experimental-strip-types "$agent_dir/scripts/ab-pack.ts" "$@"
