#!/usr/bin/env bash
# 许可窗最小全组件示意：说明、贴码、待授权列表、未决审批。
# 不连 hub，关窗即结束。现役许可窗也是这套 yad 表单。

set -euo pipefail

if command -v yad >/dev/null 2>&1; then
  exec yad --title="IM 许可 · pi-hub" \
    --text="只在本机授权。把配对码贴进来，或从待授权列表选一条。
未决审批只展示，确定才会把码交给 hub（本 demo 不真正授权）。" \
    --form \
    --field="配对码":CE \
    --field="待授权账号":CB \
    "PIHUB-" \
    "im / 林  · PIHUB-deadbeefdeadbeef!im / 客  · PIHUB-cafebabecafebabe" \
    --field="未决审批":TXT \
    "audit  sudo ls  至 13:00
capability  curl example.com  至 13:20" \
    --button="关闭:1" --button="授权:0"
fi

if ! command -v zenity >/dev/null 2>&1; then
  echo "需要 yad 或 zenity" >&2
  exit 1
fi

zenity --forms \
  --title="IM 许可 · pi-hub" \
  --text="只在本机授权。把配对码贴进来，或从待授权列表选一条。
未决审批只展示，确定才会把码交给 hub（本 demo 不真正授权）。" \
  --add-entry="配对码" \
  --add-combo="待授权账号" \
  --combo-values="im / 林  · PIHUB-deadbeefdeadbeef|im / 客  · PIHUB-cafebabecafebabe" \
  --add-multiline-entry="未决审批" \
  --separator=$'\n'
