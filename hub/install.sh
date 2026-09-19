#!/usr/bin/env bash
# 新机部署 / 改完代码热更 pi-hub 与飞书适配器。
#
#   hub/install.sh              测、编、装 unit、enable --now hub
#   hub/install.sh --reload     测、编、装 unit、restart 已在跑的服务（迭代）
#   hub/install.sh --status     只看状态
#   hub/install.sh --feishu     顺带 enable 飞书（缺 lark-cli 会装 unit 但进程 78 退出）
#   hub/install.sh --skip-test  跳过 go test
#
# 飞书默认：有 lark-cli 才 enable --now；没有就跳过并打印安装说明。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="$(cd "$ROOT/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
UNIT_DIR="${HOME}/.config/systemd/user"
LARK_CLI="${HOME}/.local/share/pnpm/lark-cli"
if [[ ! -x "$LARK_CLI" ]] && command -v lark-cli >/dev/null 2>&1; then
  LARK_CLI="$(command -v lark-cli)"
fi

reload=0
want_feishu=0
skip_test=0
status_only=0

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \?//'
}

for arg in "$@"; do
  case "$arg" in
    --reload) reload=1 ;;
    --feishu) want_feishu=1 ;;
    --skip-test) skip_test=1 ;;
    --status) status_only=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数 $arg" >&2; usage; exit 2 ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少 $1" >&2
    exit 1
  }
}

have_lark() {
  [[ -x "$LARK_CLI" ]] || command -v lark-cli >/dev/null 2>&1
}

unit_active() {
  systemctl --user is-active --quiet "$1"
}

print_status() {
  echo "== 状态 =="
  systemctl --user --no-pager --lines=6 status pi-hub.service 2>/dev/null || echo "pi-hub: 未安装"
  echo
  systemctl --user --no-pager --lines=8 status pi-hub-feishu.service 2>/dev/null || echo "pi-hub-feishu: 未安装"
  echo
  if [[ -S "${HOME}/.pi/agent/run/hub.sock" ]]; then
    echo "socket: ${HOME}/.pi/agent/run/hub.sock"
  else
    echo "socket: 不存在"
  fi
  if have_lark; then
    echo "lark-cli: $LARK_CLI"
  else
    echo "lark-cli: 未找到"
    echo "  pnpm add -g @larksuite/cli && lark-cli config init && lark-cli auth login"
  fi
}

if [[ "$status_only" -eq 1 ]]; then
  print_status
  exit 0
fi

need go
need install
need systemctl

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "主线只在 Linux + systemd --user 上装。其他系统见 tag pre-linux-hub。" >&2
  exit 1
fi

if [[ "$skip_test" -eq 0 ]]; then
  echo "== test hub =="
  (cd "$ROOT" && go test ./...)
  echo "== test feishu =="
  (cd "$ROOT/adapters/feishu" && go test ./...)
fi

echo "== build =="
mkdir -p "$BIN_DIR" "$UNIT_DIR" "${HOME}/.pi/agent/run" "${HOME}/.pi/agent/hub-state"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$ROOT" && go build -o "$tmp/pi-hub" .)
(cd "$ROOT/adapters/feishu" && go build -o "$tmp/pi-hub-feishu" .)
install -Dm755 "$tmp/pi-hub" "$BIN_DIR/pi-hub"
install -Dm755 "$tmp/pi-hub-feishu" "$BIN_DIR/pi-hub-feishu"
install -Dm644 "$ROOT/systemd/pi-hub.service" "$UNIT_DIR/pi-hub.service"
install -Dm644 "$ROOT/adapters/feishu/systemd/pi-hub-feishu.service" "$UNIT_DIR/pi-hub-feishu.service"

# unit 里写死了 pnpm 路径；本机 lark-cli 在别处时覆盖 ExecStart
if [[ -x "$LARK_CLI" && "$LARK_CLI" != "${HOME}/.local/share/pnpm/lark-cli" ]]; then
  sed -i "s|-lark-cli %h/.local/share/pnpm/lark-cli|-lark-cli ${LARK_CLI}|" "$UNIT_DIR/pi-hub-feishu.service"
fi

systemctl --user daemon-reload
systemctl --user enable pi-hub.service >/dev/null

if [[ "$reload" -eq 1 ]] && unit_active pi-hub.service; then
  echo "== restart hub =="
  systemctl --user restart pi-hub.service
else
  echo "== start hub =="
  systemctl --user enable --now pi-hub.service >/dev/null
fi

install_feishu=0
if [[ "$want_feishu" -eq 1 ]]; then
  install_feishu=1
elif have_lark; then
  install_feishu=1
fi

if [[ "$install_feishu" -eq 1 ]]; then
  systemctl --user enable pi-hub-feishu.service >/dev/null
  if have_lark; then
    if [[ "$reload" -eq 1 ]] && unit_active pi-hub-feishu.service; then
      echo "== restart feishu =="
      systemctl --user restart pi-hub-feishu.service
    else
      echo "== start feishu =="
      systemctl --user start pi-hub-feishu.service
    fi
  else
    echo "飞书 unit 已 enable，但没有 lark-cli，进程会以 78 退出、不再狂重启。"
    echo "  pnpm add -g @larksuite/cli && lark-cli config init && lark-cli auth login"
    echo "  然后: systemctl --user start pi-hub-feishu.service"
  fi
else
  echo "跳过飞书（没有 lark-cli）。需要时: $0 --feishu"
fi

print_status
echo
echo "迭代改代码后再跑: $0 --reload"
echo "只看状态: $0 --status"
