/**
 * 受保护路径扩展
 *
 * 阻止对受保护路径执行 write 和 edit 操作。
 * 适合防止误修改敏感文件。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const protectedPaths = [".env", ".git/", "node_modules/"];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		const path = event.input.path as string;
		const isProtected = protectedPaths.some((p) => path.includes(p));

		if (isProtected) {
			if (ctx.hasUI) {
				ctx.ui.notify(`已阻止写入受保护路径：${path}`, "warning");
			}
			return { block: true, reason: `路径 "${path}" 受保护` };
		}

		return undefined;
	});
}
