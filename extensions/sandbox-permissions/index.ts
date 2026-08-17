// sandbox-permissions — 沙箱权限三合一扩展（guard 防读 + gate 审批 + allow 升权）
//
// 单一扩展入口，合成三个子模块的注册（方案 B：真融合）：
//   guard.ts  敏感路径黑名单拦截（pi.on("tool_call")：read/write/edit/bash）
//   gate.ts   危险 bash 命令审批（pi.on("tool_call"/"tool_result"/"session_start"）
//   allow.ts  一次性沙箱升权工具（pi.registerTool("sandbox-allow")）
//
// 注册顺序固定：guard（硬拦截）先于 gate（审批）；allow 只注册工具，顺序无关。
// 注意：subagent 子进程仍经 lib/subagent-run.ts 以 --extension 单独加载 guard.ts，
// 不加载 gate/allow（子进程 bash 已限 worktree、无 UI 无法审批）。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import guard from "./guard";
import gate from "./gate";
import allow from "./allow";

export default async function (pi: ExtensionAPI): Promise<void> {
	await guard(pi);
	await gate(pi);
	await allow(pi);
}
