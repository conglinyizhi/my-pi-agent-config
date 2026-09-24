#!/usr/bin/env bash
# with-device-lock.sh — 给「同一台物理设备/调试目标」上一把跨进程互斥锁
#
# 背景：多开 pi（不同 session 的主 agent）与每批多个 worker 都是独立进程，adb server 却是
# 全局共享的。同一个 serial 上同时 install / push / port / adb tcpip 会互相踩，
# 表现是「命令莫名失败」「设备状态突变」，而仓库里没有任何跨进程锁。
#
# 做法：flock 一把 /tmp/pi-device-<设备>.lock。
#   - 进程死掉（含 SIGKILL）由内核自动释放，不会留死锁
#   - /tmp 是内存盘，且主 agent 与 worker 的沙箱都放行写
#   - 持锁者另写一份 .holder 便于排障（它只是线索：真值以 flock 为准）
#
# 用法：
#   with-device-lock.sh [--wait 秒] [--note 说明] [--status] <设备标识> [-- 命令...]
#
#   with-device-lock.sh emulator-5554 -- adb -s emulator-5554 install app.apk
#   with-device-lock.sh --wait 600 my-phone -- adb -s my-phone shell am force-stop com.x
#   with-device-lock.sh --status emulator-5554        # 只看谁占着，不抢锁
#
# 退出码：0 命令成功；命令自身的退出码原样返回；3 = 等待超时没拿到锁；2 = 用法错误

set -uo pipefail

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

wait_seconds=300
note=""
status_only=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait) wait_seconds="${2:?--wait 需要一个秒数}"; shift 2 ;;
    --note) note="${2:?--note 需要一句话}"; shift 2 ;;
    --status) status_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) break ;;
  esac
done

if [[ $# -eq 0 ]]; then
  echo "device-lock: 缺少设备标识（如 adb serial）" >&2
  usage >&2
  exit 2
fi

device="$1"
shift

# 设备标识进文件名：只留安全字符，避免 ../ 这类写法把锁写到别处
safe="$(printf '%s' "$device" | tr -c 'A-Za-z0-9._-' '-')"
lock="/tmp/pi-device-${safe}.lock"
holder="/tmp/pi-device-${safe}.holder"

show_holder() {
  if [[ -s $holder ]]; then
    echo "  当前/最近持锁者：" >&2
    sed 's/^/    /' "$holder" >&2
  else
    echo "  没有持锁者记录（锁可能刚被释放）" >&2
  fi
}

if [[ $status_only -eq 1 ]]; then
  # 探一次锁：拿得到说明空闲（立刻放掉），拿不到说明有人在用
  exec 9>"$lock"
  if flock -n 9; then
    echo "device-lock: ${device} 空闲（无人持锁）"
    exit 0
  fi
  echo "device-lock: ${device} 正被占用"
  show_holder
  exit 0
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi
if [[ $# -eq 0 ]]; then
  echo "device-lock: 缺少要执行的命令（用 -- 分隔）" >&2
  usage >&2
  exit 2
fi

exec 9>"$lock"
if ! flock -w "$wait_seconds" 9; then
  echo "device-lock: 等 ${wait_seconds}s 仍拿不到 ${device} 的锁，命令未执行" >&2
  show_holder
  echo "  处理：等它跑完再试，或用更长的 --wait；别绕开锁直接敲 adb（那正是要避免的事）" >&2
  exit 3
fi

{
  echo "pid=$$"
  echo "at=$(date -Is)"
  echo "device=$device"
  echo "task=${PI_TASK_ID:-（主 agent 或人工）}"
  echo "cwd=$PWD"
  [[ -n $note ]] && echo "note=$note"
  echo "cmd=$(printf '%s ' "$@")" | cut -c1-300
} > "$holder" 2>/dev/null

"$@"
status=$?

rm -f "$holder"
exit $status
