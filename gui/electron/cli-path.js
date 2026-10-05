// gui/electron/cli-path.js — 数据层那几支 CLI 桥在哪
//
// A/B 的槽里只装组件自己要的东西：gui 槽有 gui/，audit 槽有 extensions/ 与 lib/，
// 两边都没有 scripts/。所以桥脚本要回落到仓库那份（那里 lib/ 与 scripts/ 是齐的）。
// 反过来在仓库里跑时，第一候选就是自己那棵树。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** 仓库根：PI_AGENT_DIR 优先，其次 ~/.pi/agent */
export function agentRoot(env = process.env, home = homedir()) {
  return env.PI_AGENT_DIR || resolve(home, ".pi", "agent");
}

/** 找这份桥脚本：先看自己那棵树，没有就回落仓库
 *
 * @param {string} name 脚本文件名，如 flows-cli.ts
 * @param {{ here: string, env?: any, home?: string, exists?: (p: string) => boolean }} options
 *        here 是调用方所在目录（gui/electron）
 */
export function resolveCliPath(name, { here, env = process.env, home = homedir(), exists = existsSync } = {}) {
  const candidates = [resolve(here, "..", "..", "scripts", name), resolve(agentRoot(env, home), "scripts", name)];
  return candidates.find((p) => exists(p)) ?? candidates[1];
}
