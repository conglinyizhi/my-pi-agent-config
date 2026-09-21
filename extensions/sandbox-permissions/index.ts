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
import { poolAddHandler, poolRemoveHandler } from "./review-pool";
import { workspaceArgumentCompletions, workspaceCommandHandler } from "./workspace-command.ts";
import { beginSandboxSession } from "./session-access.ts";
import {
	YOLO_STATUS_KEY,
	setYolo,
	toggleYolo,
	yoloEnabled,
	yoloStatusText,
} from "./yolo.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	await guard(pi);

	// session 级目录授权只存在当前 session；session ID 变化时自动清空旧授权。
	// yolo 开关同样只存在当前 session：新 session 复位为防护开启，状态显示一并清除。
	pi.on("session_start", (_event, ctx) => {
		beginSandboxSession(ctx.sessionManager.getSessionId());
		setYolo(false);
		ctx.ui.setStatus(YOLO_STATUS_KEY, undefined);
	});
	await gate(pi);
	await allow(pi);

	// ── /yolo：会话级沙箱墙开关（可自由启停，仅当前 session）──
	// 用法：/yolo | /yolo on | /yolo off | /yolo status
	// 开启=全部降零：bash 审批链 + Landlock 写保护 + read/write 黑名单
	pi.registerCommand("yolo", {
		description: "开关沙箱墙（yolo 模式：全开 / 恢复防护）。用法 /yolo | on | off | status",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			let next: boolean;
			if (arg === "on" || arg === "1" || arg === "yes") {
				next = true;
			} else if (arg === "off" || arg === "0" || arg === "no") {
				next = false;
			} else if (arg === "status" || arg === "?") {
				const on = yoloEnabled();
				ctx.ui.notify(on ? "🚀 yolo 模式已开启：沙箱墙全部降零（仅当前 session）" : "沙箱墙正常防护（未开启 yolo）", on ? "warning" : "info");
				return;
			} else {
				next = toggleYolo();
			}
			setYolo(next);
			ctx.ui.setStatus(YOLO_STATUS_KEY, yoloStatusText());
			if (next) {
				ctx.ui.notify("🚀 yolo 模式已开启（仅当前 session）：bash 审批链、Landlock 写保护、read/write 黑名单 已全部关闭", "warning");
			} else {
				ctx.ui.notify("沙箱墙已恢复防护（bash 审批、Landlock 写保护、read/write 黑名单已生效）", "info");
			}
		},
	});

	// 审核模型池管理（fast-add 体系配套）：/provider:fast-put 添加、/provider:fast-pop 移除
	pi.registerCommand("provider:fast-put", {
		description: "从可用模型筛选一个加入审核池（LLM 预审模型池）：/provider:fast-put [关键词]",
		handler: (args, ctx) => poolAddHandler(args, ctx, pi),
	});
	pi.registerCommand("provider:fast-pop", {
		description: "从审核池移除一个模型：/provider:fast-pop [provider/model 或模型名]",
		handler: (args, ctx) => poolRemoveHandler(args, ctx),
	});

	// 副工作区管理（持久 allowDirs）：/sandbox:workspaces 列出 / add / remove
	// GUI 的目录授权是另一路；本命令是 TUI 回退时唯一能管理副工作区的手段，
	// 只用 ctx.ui（notify/select/input/confirm），不依赖 GUI 窗口。
	pi.registerCommand("sandbox:workspaces", {
		description: "管理副工作区（持久可写根 allowDirs）：列出 / add <目录> / remove <目录|序号>",
		getArgumentCompletions: (prefix) => workspaceArgumentCompletions(prefix),
		handler: (args, ctx) => workspaceCommandHandler(args, ctx),
	});
}
