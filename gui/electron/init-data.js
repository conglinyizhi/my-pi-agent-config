// gui/electron/init-data.js — 窗口配置与 GetInitData 的字段映射
//
// 这一份是 wails-gui/main.go 的 windowConfigs 与 wails-gui/app.go 的 GetInitData
// 的等价移植：窗口名 → 尺寸/标题，请求 JSON → 前端 {base} 结构。
// 前端视图不关心引擎，只吃这个结构，所以两边必须逐字段对齐。

/** 窗口名 → 尺寸与标题（Wails 版已归档到 archive/wails-gui/，不必再与它对表） */
export const WINDOW_CONFIGS = {
	editor: { title: "提示词输入 · pi", width: 900, height: 620, minWidth: 720, minHeight: 480 },
	gate: { title: "权限闸门 · 命令审批", width: 1280, height: 900, minWidth: 960, minHeight: 640 },
	subagents: { title: "Subagent 详情 · 三叉戟", width: 1280, height: 860, minWidth: 900, minHeight: 600 },
	routing: { title: "TODO 调度 · 三叉戟", width: 1000, height: 720, minWidth: 800, minHeight: 540 },
};

/** 未知窗口名时的兜底 */
export const DEFAULT_WINDOW = "gate";

/**
 * 把请求 JSON 铺成前端要的 initData。
 *
 * 缺字段一律给 undefined（JSON 序列化后就是缺键），前端各处都按"缺就不渲染"处理——
 * 这也是 Wails 版的行为，别在这里自作主张补默认值。
 */
export function buildInitData(windowName, request = {}, options = {}) {
	const req = request !== null && typeof request === "object" ? request : {};
	const base = { responseFile: options.responseFile ?? "" };

	switch (windowName) {
		case "subagents":
			base.workers = req.workers;
			break;
		case "routing":
			base.todos = req.todos;
			break;
		case "editor":
			base.clipHistory = req.clipHistory;
			break;
		default: {
			// gate：审批窗把请求原样铺开，字段名与前端 props 一一对应
			base.command = req.command;
			base.taskId = req.taskId;
			base.rules = req.rules;
			// 命令里写死的赋值解析（pi 侧算好，仅 Linux）：前端标绿/标灰并悬停显示值
			base.envNotes = req.envNotes;
			// 命令里变量使用处的渲染值（pi 侧算好，仅 Linux）：前端高亮使用处并列出变量表
			base.varRenders = req.varRenders;
			// 云端模型审核意见（verdict/reason/suggestion/opinion；缺省时前端容错为不展示）
			base.review = req.review;
			// sandbox-allow 升权审批合并进 gate 窗口：kind 判别 audit（默认）/ sandbox-allow
			base.kind = req.kind;
			// 脚本事前审核（PTC）：subject=script 时 command 是 JS 原文，影响面走 scriptEffects
			base.subject = req.subject;
			base.scriptEffects = req.scriptEffects;
			base.permission = req.permission;
			base.writePaths = req.writePaths;
			base.justification = req.justification;
			base.timeout = req.timeout;
			// 内存上限（MB；缺省时前端按缺省展示）：与 timeout 正交，超出即终止进程组
			base.memoryMb = req.memoryMb;
			// subagent capability 请求（kind=capability）：只批准精确当前命令，不提供路径升权
			base.capability = req.capability;
			base.scope = req.scope;
			base.requestReason = req.requestReason;
			// 目录白/黑名单候选：sandbox-allow 声明的 writePaths（不从命令拆路径）
			base.candidatePaths = req.candidatePaths;
			base.persistentRoots = req.persistentRoots;
			base.sessionWriteRoots = req.sessionWriteRoots;
			base.sessionTrustedRoots = req.sessionTrustedRoots;
			base.builtinRoots = req.builtinRoots;
			base.workspaceRoot = req.workspaceRoot;
			break;
		}
	}
	return base;
}

/** 从 electron 的 argv 里取窗口名与两个文件路径 */
export function parseArgv(argv) {
	const rest = argv.slice(argv.findIndex((arg) => arg.endsWith("main.js")) + 1);
	return {
		windowName: rest[0] || DEFAULT_WINDOW,
		requestFile: rest[1] || "",
		responseFile: rest[2] || "",
	};
}
