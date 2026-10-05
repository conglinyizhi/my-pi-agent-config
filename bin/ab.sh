#!/usr/bin/env bash
# A/B 的压缩入口（薄壳，实现见 scripts/ab-cli.ts）
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec node --experimental-strip-types "$here/../scripts/ab-cli.ts" "$@"
