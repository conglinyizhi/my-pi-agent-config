#!/usr/bin/env bash
# 给某个窗口开个试窗：不用等审批，也不用占着 pi。
#
#   gui-preview.sh gate          # 权限闸门（用演示脚本现场生成一份像样的请求）
#   gui-preview.sh flows         # 审核流程窗
#   gui-preview.sh review        # 审核设置窗
#   gui-preview.sh editor|routing|subagents
#   gui-preview.sh <窗口> <请求.json>   # 自己给请求
#
# 从终端起不需要 --no-sandbox；只有跑在 pi 的沙箱里（PR_SET_NO_NEW_PRIVS）才要给
# PI_GUI_ELECTRON_ARGS=--no-sandbox，否则 Chromium 的 setuid 沙箱起不来。
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
agent_dir=$(dirname "$here")

usage() {
  echo "用法：gui-preview.sh <gate|flows|review|editor|routing|subagents> [请求.json]" >&2
  exit 2
}

window=${1:-}
[ -n "$window" ] || usage
case "$window" in
  -h|--help|help) usage ;;
esac

tmp=$(mktemp -d)
request=${2:-}

if [ -z "$request" ]; then
  if [ "$window" = "gate" ]; then
    # 闸门要一份像样的请求才看得出排版：已有的演示脚本会把它写在固定位置
    node --experimental-strip-types "$agent_dir/scripts/gate-preview-demo.ts" >/dev/null
    request=/tmp/pi-gate-preview/request.json
  else
    request=$tmp/request.json
    printf "{}" > "$request"
  fi
fi

[ -f "$request" ] || { echo "请求文件不存在：$request" >&2; exit 1; }
exec "$here/gui.sh" "$window" "$request" "$tmp/response.json"
