#!/bin/sh
# scripts/ab-smoke.sh — 壳的灰盒验收：三条路径真验
#
# 单测验得了壳的逻辑，验不了"真 pi 里到底加载了哪一份"。这个脚本把 recipe 固化下来：
#   1. 从 HEAD 构建一个 audit 槽，current 指向它
#   2. 给槽内实现塞一行写文件的标记
#   3. 用这个 runtime 跑真 pi，看标记 —— 出现=实现来自槽，不出现=退回仓库
#   4. 再验两条退路：删掉 current、把槽里那份弄坏
#
# 用法：scripts/ab-smoke.sh [扩展名]   （默认 sandbox-permissions）
# 注意：会起真 pi，付出一次极小的模型调用（--offline 不拦模型调用）。
#
# 两个坑都做了防呆（我各栽过一次）：
#   脏工作区必须先提交：打包取的是 HEAD，没提交的话槽里还是老实现，整轮白验
#   标记行必须单行：带换行转义的话写进去是语法错误，测的就变成"槽坏掉"那条路径
set -eu

EXT=${1:-sandbox-permissions}
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区是脏的：先提交再跑烟测（打包取 HEAD，未提交的改动不会进槽）。" >&2
  echo "确实要用当前 HEAD 验机制的话：SKIP_DIRTY_CHECK=1 scripts/ab-smoke.sh" >&2
  [ "${SKIP_DIRTY_CHECK:-0}" = "1" ] || exit 2
fi

RT=$(mktemp -d /tmp/ab-smoke-XXXXXX)
MARKER=/tmp/ab-smoke-marker.txt
SESS="$RT/sessions"
mkdir -p "$SESS"
rm -f "$MARKER"
FAIL=0

fail() { echo "  ✗ $1"; FAIL=1; }
pass() { echo "  ✓ $1"; }

run_pi() {
  PI_RUNTIME_ROOT="$RT" timeout 120 node_modules/.bin/pi \
    --no-extensions -e "extensions/$EXT/index.ts" \
    --offline --no-session --session-dir "$SESS" --print "x" >"$1" 2>&1 || true
}

echo "扩展：$EXT"
echo "临时 runtime：$RT"
echo "构建槽："
bin/ab-pack audit --slot dev --runtime-root "$RT" | sed "s/^/  /"
bin/ab-slot switch audit dev --runtime-root "$RT" >/dev/null

SLOT_ENTRY="$RT/audit/dev/extensions/$EXT/index.ts"
if head -1 "$SLOT_ENTRY" | grep -q "export { default }"; then
  pass "槽内入口已摊平（不然壳加载壳会递归）"
else
  fail "槽内入口没摊平：$SLOT_ENTRY 还是壳（多半是没提交就打包）"
fi

MARKER_LINE='import("node:fs").then((fs) => fs.appendFileSync("/tmp/ab-smoke-marker.txt", "loaded"));'
printf '%s\n' "$MARKER_LINE" >> "$RT/audit/dev/extensions/$EXT/impl.ts"

echo ""
echo "路径一：槽在（实现该来自槽）"
run_pi "$RT/pi-slot.log"
if [ -f "$MARKER" ]; then pass "槽内实现确实被加载了"; else fail "槽在，但实现没从槽加载"; fi
grep -qi "failed to load" "$RT/pi-slot.log" && fail "pi 报了扩展加载失败" || pass "pi 没有扩展加载错误"

rm -f "$RT/audit/current" "$MARKER"
echo ""
echo "路径二：删掉 current（该退回仓库）"
run_pi "$RT/pi-repo.log"
if [ -f "$MARKER" ]; then fail "current 删了却还在用槽里的实现"; else pass "退回仓库实现"; fi
grep -qi "failed to load" "$RT/pi-repo.log" && fail "pi 报了扩展加载失败" || pass "pi 没有扩展加载错误"

bin/ab-slot switch audit dev --runtime-root "$RT" >/dev/null
printf 'export default function broken( \n' >> "$RT/audit/dev/extensions/$EXT/impl.ts"
echo ""
echo "路径三：槽里那份弄坏（该退回仓库且不把 pi 弄死）"
run_pi "$RT/pi-broken.log"
if [ -f "$MARKER" ]; then fail "槽里那份坏了却还在用"; else pass "退回仓库实现"; fi
grep -qi "failed to load" "$RT/pi-broken.log" && fail "pi 报了扩展加载失败" || pass "pi 没有扩展加载错误"

echo ""
if [ "$FAIL" = "0" ]; then
  echo "三条路径全通过。日志与槽留在 $RT"
else
  echo "有失败项，日志与槽留在 $RT，日志：$RT/pi-*.log" >&2
fi
exit "$FAIL"
