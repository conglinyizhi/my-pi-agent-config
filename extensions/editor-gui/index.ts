// GUI 构建参考：skill gui-standards（GUI 骨架 + Vue + rsbuild + esbuild 模式）
//
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runGuiWindow, findGuiBinary } from "../../lib/gui-runner";

const HIST_FILE = path.join(os.homedir(), ".pi", "agent", "queue", "cliphist.json");
const MAX_HISTORY = 15;

function loadHistory(): string[] {
	try {
		if (!fs.existsSync(HIST_FILE)) return [];
		return JSON.parse(fs.readFileSync(HIST_FILE, "utf-8")) || [];
	} catch { return []; }
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("prompt-edit-gui", {
		description: "提示词编辑工具（查看 Ctrl+C 历史 / 编辑文件）",
		handler: async (args, ctx) => {
			if (!findGuiBinary()) {
				ctx.ui.notify("未找到 wails-gui。请先构建：cd wails-gui && wails build -tags webkit2_41", "error");
				return;
			}

			// 构建请求
			const clipHistory = loadHistory();
			const request: any = { clipHistory, file: null };

			// 如果有参数作为文件路径
			if (args && args.trim()) {
				const absPath = path.resolve(ctx.cwd, args.trim());
				if (fs.existsSync(absPath)) request.file = absPath;
			}

			ctx.ui.notify("正在启动提示词编辑工具...", "info");

			const result = await runGuiWindow("editor", request, { timeoutMs: 300000 });
			if (!result.ok || result.data?.cancelled) {
				return;
			}

			if (result.data.action === "restore" && result.data.text) {
				ctx.ui.setEditorText(result.data.text);
				ctx.ui.notify("内容已恢复到输入框", "info");
			}
		},
	});
}
