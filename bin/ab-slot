#!/bin/sh
# bin/ab-slot — A/B 更新引擎的槽位管理（status / switch / rollback / promote / note / log）
#
# 薄壳：真正干活的是 scripts/ab-slot.ts。需要 node 与 TS 支持；
# 应急回退走 bin/ab-rollback（纯 shell，不依赖 node，见它的注释）。
set -eu
agent_dir=$(cd "$(dirname "$0")/.." && pwd)
exec node --experimental-strip-types "$agent_dir/scripts/ab-slot.ts" "$@"
