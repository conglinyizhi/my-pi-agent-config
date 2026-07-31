// GUI 构建参考：skill gui-standards（GUI 骨架 + Vue + rsbuild + esbuild 模式）
//
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { spawn, execSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";

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
			// 查找 electron
			let electronBin: string | null = null;
			try {
				const bins = execSync("ls /usr/bin/electron* 2>/dev/null", { encoding: "utf-8" })
					.trim().split("\n").filter(Boolean).sort().reverse();
				electronBin = bins[0] || null;
			} catch {}
			if (!electronBin) {
				ctx.ui.notify("未找到 electron。请安装：yay -S electron", "error");
				return;
			}

			const guiDir = path.join(os.homedir(), ".pi", "agent", "extensions", "editor-gui", "gui");
			const appJs = path.join(guiDir, "app.mjs");
			const distHtml = path.join(guiDir, "dist", "index.html");
			if (!fs.existsSync(appJs) || !fs.existsSync(distHtml)) {
				ctx.ui.notify("GUI 未构建。请执行：pnpm build:gui-editor", "error");
				return;
			}

			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-edit-gui-"));
			const requestFile = path.join(tmpDir, "request.json");
			const responseFile = path.join(tmpDir, "response.json");

			// 构建请求
			const clipHistory = loadHistory();
			const request: any = { clipHistory, file: null };

			// 如果有参数作为文件路径
			if (args && args.trim()) {
				const absPath = path.resolve(ctx.cwd, args.trim());
				if (fs.existsSync(absPath)) request.file = absPath;
			}

			fs.writeFileSync(requestFile, JSON.stringify(request));

			ctx.ui.notify("正在启动提示词编辑工具...", "info");

			try {
				const proc = spawn(electronBin, [appJs, requestFile, responseFile], {
					stdio: "ignore",
					detached: true,
				});

				const result = await new Promise<any>((resolve) => {
					const timeout = setTimeout(() => {
						try { proc.kill("SIGTERM"); } catch {}
						resolve({ cancelled: true });
					}, 300000);

					const check = setInterval(() => {
						try {
							const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
							clearTimeout(timeout);
							clearInterval(check);
							resolve(data);
						} catch {}
					}, 300);

					proc.on("close", () => {
						setTimeout(() => {
							try {
								const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
								clearTimeout(timeout);
								clearInterval(check);
								resolve(data);
							} catch {
								clearTimeout(timeout);
								clearInterval(check);
								resolve({ cancelled: true });
							}
						}, 100);
					});
				});

				if (!result || result.cancelled) {
					return;
				}

				if (result.action === "restore" && result.text) {
					ctx.ui.setEditorText(result.text);
					ctx.ui.notify("内容已恢复到输入框", "info");
				}
			} finally {
				try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
			}
		},
	});
}
