// sandbox-permissions — 沙箱权限三合一扩展（guard 防读 + gate 审批 + allow 升权）
//
// 单一扩展入口，合成三个子模块的注册（方案 B：真融合）：
//   guard.ts  敏感路径黑名单拦截（pi.on("tool_call")：read/write/edit/bash）
//   gate.ts   危险 bash 命令审批（pi.on("tool_call"/"tool_result"/"session_start"）
//   allow.ts  一次性沙箱升权工具（pi.registerTool("sandbox-allow")）
// 另带两个人类侧的配置命令：/sandbox:paths（三类路径）与 /sandbox:network（worker 出网档位）。
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
import { pathsArgumentCompletions, pathsCommandHandler } from "./paths-command.ts";
import { networkArgumentCompletions, networkCommandHandler } from "./network-command.ts";
import { reviewCommandHandler } from "./review-command.ts";
import { openFlowsGui } from "./flows-gui.ts";
import { beginSandboxSession } from "./session-access.ts";
import { takeAllNotices } from "../../lib/ab-notice.ts";
import { resolveRuntimeRoot } from "../../lib/ab-watch.ts";
import { compareSpecs, specFromManifest } from "../../lib/gui-spec.ts";
import { activeDir, componentPath, readManifestOf } from "../../lib/ab-tag.ts";
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
		// A/B 更新引擎的消息：晋升、回退、协议不匹配这类事发生时未必有人在看，
		// 所以落成文件，在这里读一次露个面然后消费掉。整段包起来：提示失败不能影响会话启动。
		try {
			const runtimeRoot = resolveRuntimeRoot();
			for (const entry of takeAllNotices(runtimeRoot)) {
				for (const line of entry.lines) ctx.ui.notify(`[A/B ${entry.component}] ${line}`, "info");
			}
			const dir = activeDir(componentPath(runtimeRoot, "gui"));
			const spec = dir ? specFromManifest(readManifestOf(dir)) : undefined;
			if (spec) {
				for (const line of compareSpecs(spec).notices) ctx.ui.notify(`[GUI] ${line}`, "info");
			}
		} catch {
			// 观察与提示都不该挡住会话
		}
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

	// 三类沙箱路径配置（trustedProgramDirs / allowDirs / blockDirs）：/sandbox:paths
	// 有图形（yad + DISPLAY）时开窗口；否则回退 ctx.ui 逐项提问。
	// /sandbox:trusted 是别名（这个名字先出现在文档里，留着免得手滑）。
	// trustedProgramDirs 是人类的权限：命令只做确认后写入，不做任何预填。
	const pathsDescription =
		"管理三类沙箱路径配置（可信程序目录 / 副工作区 / 黑名单）：列出 | add <trusted|allow|block> <目录> | remove <类型> <目录|序号>";
	pi.registerCommand("sandbox:paths", {
		description: pathsDescription,
		getArgumentCompletions: (prefix) => pathsArgumentCompletions(prefix),
		handler: (args, ctx) => pathsCommandHandler(args, ctx),
	});
	pi.registerCommand("sandbox:trusted", {
		description: pathsDescription,
		getArgumentCompletions: (prefix) => pathsArgumentCompletions(prefix),
		handler: (args, ctx) => pathsCommandHandler(args, ctx),
	});

	// worker 出网审核强度（三档）：/sandbox:network
	// 有图形（yad + DISPLAY）时开窗口三选一；否则回退逐项提问。放宽方向写盘前确认，
	// 收紧直接做。命令行直接带档位词也支持（/sandbox:network loose）。
	pi.registerCommand("sandbox:network", {
		description: "worker 出网审核强度：off / whitelist / loose（缺省开窗口选择，可带档位词直接设）",
		getArgumentCompletions: (prefix) => networkArgumentCompletions(prefix),
		handler: (args, ctx) => networkCommandHandler(args, ctx),
	});

	// 副工作区管理（持久 allowDirs）：/sandbox:workspaces 列出 / add / remove
	// GUI 的目录授权是另一路；本命令是 TUI 回退时唯一能管理副工作区的手段，
	// 只用 ctx.ui（notify/select/input/confirm），不依赖 GUI 窗口。
	pi.registerCommand("sandbox:flows", {
		description: "审核流程：开窗看流程图与校验状态（review-flows/*.ts；改完要 /reload）",
		handler: async (_args, ctx) => {
			const result = openFlowsGui();
			if (!result.opened) {
				ctx.ui.notify(`审核流程窗打不开：${result.reason ?? "未知原因"}`, "warning");
				return;
			}
			ctx.ui.notify("已打开审核流程窗", "info");
		},
	});

	pi.registerCommand("sandbox:gui", {
		description: "审核工作流设置：开设置窗改总开关/档位/后端/超时/缓存/分类器与八个维度的阈值；无图形时回退 TUI 面板。用法 /sandbox:gui [key]",
		handler: (args, ctx) => reviewCommandHandler(args, ctx),
	});

	// 旧名字留个别名：肌肉记忆还写着 /sandbox:review，行为完全一样
	pi.registerCommand("sandbox:review", {
		description: "旧名，等价于 /sandbox:gui",
		handler: (args, ctx) => reviewCommandHandler(args, ctx),
	});

	pi.registerCommand("sandbox:workspaces", {		description: "管理副工作区（持久可写根 allowDirs）：列出 / add <目录> / remove <目录|序号>",
		getArgumentCompletions: (prefix) => workspaceArgumentCompletions(prefix),
		handler: (args, ctx) => workspaceCommandHandler(args, ctx),
	});
}
