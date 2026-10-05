#!/bin/sh
# scripts/gui-canary.sh — GUI 启动自检：窗到底能不能起来
#
# 引擎平时只在真批准时顺带看见窗口活没活（那次往返的成败）。这个脚本给一次独立的探针：
#   起一个 gate 窗（合成请求，不涉及任何真审批）→ 等 .ready（前端挂载完成）→ 判定
#
# 结果记进引擎，但**不进晋升连胜**：自检成功不算"你用过一次"，只把连续失败清零；
# 失败照常累进，到门槛就触发看门狗把版本退回去（都是 ab-slot health 的语义）。
#
# 用法：scripts/gui-canary.sh [超时秒数]
#   GUI_BIN=<启动器>        换一个实现（测试用；默认仓库里的 bin/gui.sh）
#   PI_RUNTIME_ROOT=<dir>   运行时根（默认 ~/.pi/runtime；没初始化过 gui 组件就只打印结论）
set -eu

TIMEOUT=${1:-25}
REPO=$(cd "$(dirname "$0")/.." && pwd)
GUI_BIN=${GUI_BIN:-$REPO/bin/gui.sh}
RT=${PI_RUNTIME_ROOT:-$HOME/.pi/runtime}

WORK=$(mktemp -d /tmp/pi-gui-canary-XXXXXX)
REQ=$WORK/request.json
RES=$WORK/response.json

cat > "$REQ" <<'REQJSON'
{ "kind": "audit", "command": "echo canary", "taskId": "gui-canary", "rules": [] }
REQJSON

# setsid：把启动器与它拉起的 Electron 放进一个进程组，判定完能整组收掉、不留窗
setsid "$GUI_BIN" gate "$REQ" "$RES" >"$WORK/gui.log" 2>&1 &
PID=$!

OK=0
REASON="到 $TIMEOUT 秒还没等到 .ready（前端没挂上，或窗口卡在启动）"
I=0
while [ "$I" -lt "$TIMEOUT" ]; do
  if [ -f "$RES.ready" ]; then
    OK=1
    REASON="窗口起来了（.ready 已写出）"
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    REASON="启动器提前退出（没写出 .ready）"
    break
  fi
  sleep 1
  I=$((I + 1))
done

kill -TERM -"$PID" 2>/dev/null || true
sleep 1
kill -KILL -"$PID" 2>/dev/null || true

if [ "$OK" = "1" ]; then
  echo "自检通过：$REASON"
else
  echo "自检失败：$REASON" >&2
  echo "  日志：$WORK/gui.log" >&2
  tail -5 "$WORK/gui.log" >&2 2>/dev/null || true
fi

# 记进引擎：只有 gui 组件初始化过才记（否则等于在一台没启用的机器上凭空造状态）
if [ -d "$RT/gui" ]; then
  if [ "$OK" = "1" ]; then
    "$REPO/bin/ab-slot.sh" health gui ok --reason "$REASON" --runtime-root "$RT" >/dev/null
  else
    "$REPO/bin/ab-slot.sh" health gui fail --reason "$REASON" --runtime-root "$RT" >/dev/null
  fi
  echo "（已记入 A/B 引擎：自检不进晋升连胜，连续失败到门槛会触发自动回退）"
else
  echo "（gui 组件未初始化，本次只打印结论，没往运行时目录写东西）"
fi

[ "$OK" = "1" ]
