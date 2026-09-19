// remote-hub — pi 只提供入口，窗和授权都由 hub 管。
//
// /remote:allow-key <PIHUB-码>  把码交给 hub
// /remote:gui                   让 hub 拉起本机许可窗

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { grantPairingCode, openAllowGUI } from "../../lib/hub-admin.ts";

function hubDown(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return `连不上 hub：${message}。先 systemctl --user start pi-hub.service，说明见 hub/README.md。`;
}

function principalLabel(channel: string, userId: string, displayName?: string): string {
	const name = displayName?.trim() || userId;
	return `${channel} / ${name}`;
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("remote:allow-key", {
		description: "把 IM 配对码交给本机 hub 授权该账号。用法 /remote:allow-key PIHUB-…",
		handler: async (args, ctx) => {
			const code = args.trim();
			if (!code) {
				ctx.ui.notify("用法：/remote:allow-key PIHUB-xxxxxxxx", "warning");
				return;
			}
			try {
				const p = await grantPairingCode(code);
				ctx.ui.notify(`已授权 ${principalLabel(p.channel, p.userId, p.displayName)}`, "info");
			} catch (err) {
				ctx.ui.notify(hubDown(err), "error");
			}
		},
	});

	pi.registerCommand("remote:gui", {
		description: "让 hub 打开本机 IM 许可窗（待授权账号 / 未决审批）",
		handler: async (_args, ctx) => {
			try {
				await openAllowGUI();
				ctx.ui.notify("已请 hub 打开许可窗", "info");
			} catch (err) {
				ctx.ui.notify(hubDown(err), "error");
			}
		},
	});
}
