// gui/electron/editor-open.js — 把文件或差异丢给本机编辑器
//
// 审核窗里点"在编辑器打开"走这条路：窗口本身只显示，真要读代码还是去编辑器。
// 每条命令都在这里拼好（纯函数，可单测），主进程只负责探测与 spawn。
//
// 命令行细节都对着本机 --help 或官方 CLI 文档核过：
//   code: -g file:line 行定位；--diff A B 差异
//   zed:  file:line 行定位；--diff A B 差异（二进制名可能是 zed 或 zeditor）
//   kate: -l 行 file；没有命令行差异模式
//   kompare: -c A B 比两个文件；-o file 打开一份 diff
//
// spawn 一律用数组参数、不经 shell：路径来自脚本，不能被当成命令解释。

/** 注册表：能力分三类，缺哪个能力就不给哪个按钮 */
export const EDITOR_REGISTRY = [
	{
		id: "code",
		label: "VSCode",
		bins: ["code", "code-oss"],
		openFile: ["{path}"],
		openLine: ["-g", "{path}:{line}"],
		diff: ["--diff", "{left}", "{right}"],
	},
	{
		id: "codium",
		label: "VSCodium",
		bins: ["codium", "vscodium"],
		openFile: ["{path}"],
		openLine: ["-g", "{path}:{line}"],
		diff: ["--diff", "{left}", "{right}"],
	},
	{
		id: "zed",
		label: "Zed",
		bins: ["zed", "zeditor"],
		openFile: ["{path}"],
		openLine: ["{path}:{line}"],
		diff: ["--diff", "{left}", "{right}"],
	},
	{
		id: "kate",
		label: "Kate",
		bins: ["kate"],
		openFile: ["{path}"],
		openLine: ["-l", "{line}", "{path}"],
		diff: null,
	},
	{ id: "meld", label: "Meld", bins: ["meld"], openFile: null, openLine: null, diff: ["{left}", "{right}"] },
	{ id: "kompare", label: "Kompare", bins: ["kompare"], openFile: null, openLine: null, diff: ["-c", "{left}", "{right}"] },
	{ id: "kdiff3", label: "KDiff3", bins: ["kdiff3"], openFile: null, openLine: null, diff: ["{left}", "{right}"] },
];

/**
 * 探测本机有哪些编辑器。
 * hasBinary 由主进程注入（which / 查常见路径），这样这个模块能单测。
 */
export function detectEditors(hasBinary, registry = EDITOR_REGISTRY) {
	const out = [];
	for (const editor of registry) {
		const bin = editor.bins.find((candidate) => hasBinary(candidate));
		if (!bin) continue;
		out.push({
			id: editor.id,
			label: editor.label,
			bin,
			canOpen: Boolean(editor.openFile || editor.openLine),
			canDiff: Boolean(editor.diff),
		});
	}
	return out;
}

function substitute(template, values) {
	return template.map((part) => part.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? "")));
}

/**
 * 拼一条命令。
 *
 * kind：open 打开文件（有 line 就定位到行）/ diff 看差异。
 * 拿不到必需字段、或这个编辑器没有该能力时返回 error，让界面把按钮置灰说清原因。
 */
export function buildEditorCommand(editor, request) {
	if (!editor) return { error: "没有可用的编辑器" };
	const kind = request?.kind;
	if (kind === "diff") {
		if (!editor.diff) return { error: `${editor.label} 没有命令行差异模式` };
		if (!request.left || !request.right) return { error: "缺少要比的两份文本" };
		return { bin: editor.bin, args: substitute(editor.diff, { left: request.left, right: request.right }) };
	}
	if (!request?.path) return { error: "缺少要打开的文件" };
	if (request.line && editor.openLine) {
		return { bin: editor.bin, args: substitute(editor.openLine, { path: request.path, line: request.line }) };
	}
	if (editor.openFile) return { bin: editor.bin, args: substitute(editor.openFile, { path: request.path }) };
	if (editor.openLine) return { bin: editor.bin, args: substitute(editor.openLine, { path: request.path, line: request.line ?? 1 }) };
	return { error: `${editor.label} 打不开文件` };
}
