#!/usr/bin/env bash
# 新机部署 / 改完代码热更 pi-photo（手机照片网关）。
#
#   photo/install.sh              测、编、装 unit、enable --now
#   photo/install.sh --reload     测、编、装 unit、restart 已在跑的服务（迭代）
#   photo/install.sh --status     只看状态
#   photo/install.sh --skip-test  跳过 go test
#
# 装完不打印 token：口令走终端等于把口令写进滚动历史，需要时自己
#   cat ~/.pi/agent/photo-state/token

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
UNIT_DIR="${HOME}/.config/systemd/user"
STATE_DIR="${HOME}/.pi/agent/photo-state"
RUN_DIR="${HOME}/.pi/agent/run"
SOCKET="${RUN_DIR}/photo.sock"

reload=0
skip_test=0
status_only=0

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \?//'
}

for arg in "$@"; do
  case "$arg" in
    --reload) reload=1 ;;
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

unit_active() {
  systemctl --user is-active --quiet "$1"
}

print_status() {
  echo "== 状态 =="
  systemctl --user --no-pager --lines=8 status pi-photo.service 2>/dev/null || echo "pi-photo: 未安装"
  echo
  if [[ -S "$SOCKET" ]]; then
    echo "socket: $SOCKET"
  else
    echo "socket: 不存在"
  fi
  if [[ -f "$STATE_DIR/token" ]]; then
    echo "token:  $STATE_DIR/token"
    echo "地址:   http://<本机局域网 IP>:8787/?k=\$(cat $STATE_DIR/token)"
  else
    echo "token:  未生成（守护还没跑过）"
  fi
  echo
  echo "只读运行示例（临时目录，不碰 systemd、不碰真实 state）："
  echo "  cd $ROOT && go run . -state /tmp/photo-state -socket /tmp/photo.sock -addr 127.0.0.1:8787"
}

if [[ "$status_only" -eq 1 ]]; then
  print_status
  exit 0
fi

need go
need install
need systemctl

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "只支持 Linux + systemd --user：锁与 socket 权限都建在 Unix 语义上。" >&2
  exit 1
fi

if [[ "$skip_test" -eq 0 ]]; then
  echo "== test photo =="
  (cd "$ROOT" && go test ./...)
fi

echo "== build =="
mkdir -p "$BIN_DIR" "$UNIT_DIR" "$RUN_DIR" "$STATE_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$ROOT" && go build -o "$tmp/pi-photo" .)
install -Dm755 "$tmp/pi-photo" "$BIN_DIR/pi-photo"
install -Dm644 "$ROOT/systemd/pi-photo.service" "$UNIT_DIR/pi-photo.service"

systemctl --user daemon-reload
systemctl --user enable pi-photo.service >/dev/null

if [[ "$reload" -eq 1 ]] && unit_active pi-photo.service; then
  echo "== restart =="
  systemctl --user restart pi-photo.service
else
  echo "== start =="
  systemctl --user enable --now pi-photo.service >/dev/null
fi

print_status
echo
echo "迭代改代码后再跑: $0 --reload"
echo "只看状态: $0 --status"
