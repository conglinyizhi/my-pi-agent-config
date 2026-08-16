#!/usr/bin/env bash
# build.sh — 构建 Go 版 landlock-run（输出到 scripts/vendor/landlock-run）
#
# 用法：./scripts/vendor/landlock-run-go/build.sh [GOOS] [GOARCH]
#   默认构建当前平台；交叉编译示例：./build.sh linux arm64
# 产物是静态二进制（CGO_ENABLED=0），不提交 git（见 .gitignore）。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$DIR/../landlock-run"
GOOS="${1:-$(go env GOOS)}"
GOARCH="${2:-$(go env GOARCH)}"

echo "==> building landlock-run (GOOS=$GOOS GOARCH=$GOARCH) -> $TARGET"
cd "$DIR"
CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" go build \
  -trimpath -ldflags="-s -w" -o "$TARGET" .

echo "==> done: $(ls -lh "$TARGET" | awk '{print $5, $9}')"
# probe 只在产物平台 == 本机平台时可运行（交叉编译产物不能在本机跑）
if [ "$GOOS" = "$(go env GOOS)" ]; then
  "$TARGET" --probe
fi
