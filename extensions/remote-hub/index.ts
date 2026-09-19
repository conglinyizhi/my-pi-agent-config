// remote-hub — pi 只提供入口，窗和授权都由 hub 管。
//
// /remote:allow-key <PIHUB-码>  把码交给 hub
// /remote:gui                   让 hub 拉起本机许可窗

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { grantPairingCode, openAllowGUI } from "../../lib/hub-admin.ts";

const execFileAsync = promisify(execFile);
const FEISHU_HINT =
	"飞书通道需要本机 lark-cli。安装：pnpm add -g @larksuite/cli，然后 lark-cli config init && lark-cli auth login。装好后 systemctl --user start pi-hub-feishu.service。说明见 hub/adapters/feishu/README.md。";

function hubDown(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return `连不上 hub：${message}。先 systemctl --user start pi-hub.service，说明见 hub/README.md。`;
}

function principalLabel(channel: string, userId: string, displayName?: string): string {
	const name = displayName?.trim() || userId;
	return `${channel} / ${name}`;
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const hint = await feishuChannelHint();
		if (hint) ctx.ui.notify(hint, "warning");
	});

	pi.registerCommand("remote:status", {
		description: "看本机 hub / 飞书通道是否就绪",
		handler: async (_args, ctx) => {
			const lines = await remoteStatusLines();
			ctx.ui.notify(lines.join("\n"), lines.some(l => l.includes("未")) ? "warning" : "info");
		},
	});

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

async function feishuChannelHint(): Promise<string | undefined> {
	const enabled = await unitEnabled("pi-hub-feishu.service");
	if (!enabled) return undefined;
	const active = await unitActive("pi-hub-feishu.service");
	if (active) return undefined;
	return FEISHU_HINT;
}

async function remoteStatusLines(): Promise<string[]> {
	const hub = await unitActive("pi-hub.service");
	const feishuOn = await unitEnabled("pi-hub-feishu.service");
	const feishu = await unitActive("pi-hub-feishu.service");
	const lines = [
		hub ? "hub：在跑" : "hub：未在跑（systemctl --user start pi-hub.service）",
	];
	if (!feishuOn) {
		lines.push("飞书：未启用 unit");
	} else if (feishu) {
		lines.push("飞书：在跑");
	} else {
		lines.push("飞书：unit 已启用但没在跑");
		lines.push(FEISHU_HINT);
	}
	return lines;
}

async function unitActive(name: string): Promise<boolean> {
	return (await userctl(["is-active", name])) === "active";
}

async function unitEnabled(name: string): Promise<boolean> {
	const out = await userctl(["is-enabled", name]);
	return out === "enabled" || out === "enabled-runtime" || out === "linked" || out === "linked-runtime";
}

async function userctl(args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("systemctl", ["--user", ...args], {
			timeout: 1500,
			env: process.env,
		});
		return stdout.trim();
	} catch (err) {
		const stdout = (err as { stdout?: string }).stdout;
		return typeof stdout === "string" ? stdout.trim() : "";
	}
}
