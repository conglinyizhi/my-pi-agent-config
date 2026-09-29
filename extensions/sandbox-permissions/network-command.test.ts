// network-command.test.ts — /sandbox:network 的解析、TUI 回退与 yad 通道（假 runner）
//
// 跑法：node --test --experimental-strip-types extensions/sandbox-permissions/network-command.test.ts
//
// 约定：
//   - 读写指向 mktemp 目录里的 network-policy.json，绝不碰真实配置
//   - yad 一律用假 runner（真 yad 是阻塞式窗口，测试里不许拉起来）
//   - TUI 路径用假 ctx.ui，断言「实际调了哪个方法、传了什么」
//   - 重点盯：放宽才确认、收紧不确认、取消不写盘

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setNetworkPolicyFileForTest } from "./network-policy.ts";
import {
	NETWORK_USAGE,
	confirmBody,
	isRelaxing,
	networkCommandHandler,
	networkStatusText,
	parseNetworkArgs,
	type NetworkCommandContext,
} from "./network-command.ts";
import type { YadResult, YadRunner } from "./yad-paths.ts";

const tmp = mkdtempSync(join(tmpdir(), "network-command-test-"));
const FILE = join(tmp, "network-policy.json");
setNetworkPolicyFileForTest(FILE);
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 直接写配置：mtime 往后拨，避开同尺寸同时刻的缓存命中 */
let stamp = Date.now() + 60_000;
function writeMode(mode: string): void {
	writeFileSync(FILE, `${JSON.stringify({ mode }, null, 2)}\n`);
	stamp += 1000;
	const t = new Date(stamp);
	utimesSync(FILE, t, t);
}

function readMode(): string | undefined {
	try {
		return JSON.parse(readFileSync(FILE, "utf8")).mode;
	} catch {
		return undefined;
	}
}

// ── 假 ctx.ui ──
interface FakeOptions {
	agree?: boolean;
	choice?: string;
	hasUI?: boolean;
}

function fakeCtx(opts: FakeOptions = {}) {
	const notices: { message: string; type?: string }[] = [];
	const confirms: { title: string; message: string }[] = [];
	const selects: { title: string; options: string[] }[] = [];
	const ui = {
		notify: (message: string, type?: "info" | "warning" | "error") => {
			notices.push({ message, type });
		},
		confirm: async (title: string, message: string) => {
			confirms.push({ title, message });
			return opts.agree ?? false;
		},
		select: async (title: string, options: string[]) => {
			selects.push({ title, options });
			if (opts.choice === undefined) return undefined;
			return options.find((o) => o.includes(opts.choice as string));
		},
	};
	const ctx: NetworkCommandContext = { ui, hasUI: opts.hasUI ?? true };
	return { ctx, notices, confirms, selects };
}

const noticeText = (notices: { message: string }[]) => notices.map((n) => n.message).join("\n");

// ── 假 yad runner ──
function fakeYad(script: YadResult[] | ((args: string[]) => YadResult)) {
	const calls: string[][] = [];
	const runner: YadRunner = async (_bin, args) => {
		calls.push(args);
		if (typeof script === "function") return script(args);
		const idx = Math.min(calls.length - 1, script.length - 1);
		return script[idx] ?? { code: 1, stdout: "", stderr: "" };
	};
	return { runner, calls };
}

const OK = (stdout = ""): YadResult => ({ code: 0, stdout, stderr: "" });
const CANCEL: YadResult = { code: 1, stdout: "", stderr: "" };

/** 图形通道可用（有 yad、有 DISPLAY），runner 为假的 */
const guiDeps = (runner: YadRunner) => ({
	runner,
	findYad: () => "/usr/bin/yad",
	hasDisplay: () => true,
	env: {} as NodeJS.ProcessEnv,
});

beforeEach(() => {
	writeMode("whitelist");
});

describe("参数解析", () => {
	it("无参数 → 走选择流程", () => {
		assert.deepEqual(parseNetworkArgs(""), { kind: "pick" });
		assert.deepEqual(parseNetworkArgs("   "), { kind: "pick" });
	});

	it("档位词直接设档（也接受 set 前缀）", () => {
		assert.deepEqual(parseNetworkArgs("off"), { kind: "set", mode: "off" });
		assert.deepEqual(parseNetworkArgs("LOOSE"), { kind: "set", mode: "loose" });
		assert.deepEqual(parseNetworkArgs("set whitelist"), { kind: "set", mode: "whitelist" });
	});

	it("status / help 各有出口", () => {
		assert.deepEqual(parseNetworkArgs("status"), { kind: "status" });
		assert.deepEqual(parseNetworkArgs("help"), { kind: "help" });
	});

	it("认不出的词带回原词（提示里要写清）", () => {
		assert.deepEqual(parseNetworkArgs("lo"), { kind: "pick", unknown: "lo" });
	});

	it("宽松/收紧的方向判定", () => {
		assert.equal(isRelaxing("whitelist", "loose"), true);
		assert.equal(isRelaxing("loose", "off"), true);
		assert.equal(isRelaxing("whitelist", "off"), true);
		assert.equal(isRelaxing("off", "whitelist"), false);
		assert.equal(isRelaxing("loose", "whitelist"), false);
	});
});

describe("TUI 通道", () => {
	it("选中某一档 → 写盘并通知（收紧方向不弹确认）", async () => {
		writeMode("loose");
		const { ctx, confirms, notices } = fakeCtx({ choice: "whitelist" });
		await networkCommandHandler("", ctx, { findYad: () => null });
		assert.equal(readMode(), "whitelist");
		assert.equal(confirms.length, 0, "收紧方向不该再确认");
		assert.match(noticeText(notices), /已设为 whitelist/);
	});

	it("放宽方向要确认，确认后才写盘", async () => {
		const { ctx, confirms, notices } = fakeCtx({ choice: "loose", agree: true });
		await networkCommandHandler("", ctx, { findYad: () => null });
		assert.equal(readMode(), "loose");
		assert.equal(confirms.length, 1);
		assert.match(confirms[0]?.message ?? "", /会放宽对 AI 命令/);
		assert.match(noticeText(notices), /已设为 loose/);
	});

	it("放宽但用户不确认 → 不写盘", async () => {
		const { ctx, notices } = fakeCtx({ choice: "off", agree: false });
		await networkCommandHandler("", ctx, { findYad: () => null });
		assert.equal(readMode(), "whitelist");
		assert.match(noticeText(notices), /已取消/);
	});

	it("直接带档位参数：放宽仍要确认一次", async () => {
		const { ctx, confirms } = fakeCtx({ agree: true });
		await networkCommandHandler("loose", ctx, { findYad: () => null });
		assert.equal(readMode(), "loose");
		assert.equal(confirms.length, 1);
	});

	it("已是同一档：不写盘、不确认，只说明", async () => {
		const { ctx, confirms, notices } = fakeCtx({ agree: true });
		await networkCommandHandler("whitelist", ctx, { findYad: () => null });
		assert.equal(confirms.length, 0);
		assert.match(noticeText(notices), /已经是 whitelist/);
	});

	it("无交互界面且没带参数 → 报错不写盘", async () => {
		const { ctx, notices } = fakeCtx({ hasUI: false });
		await networkCommandHandler("", ctx, { findYad: () => null });
		assert.equal(readMode(), "whitelist");
		assert.equal(notices.at(-1)?.type, "error");
		assert.match(noticeText(notices), /请带参数/);
	});

	it("认不出的词 → 提示三档写法，不进入选择", async () => {
		const { ctx, selects, notices } = fakeCtx({ choice: "loose", agree: true });
		await networkCommandHandler("wat", ctx, { findYad: () => null });
		assert.equal(selects.length, 0);
		assert.equal(notices.at(-1)?.type, "warning");
		assert.match(noticeText(notices), /无法识别「wat」/);
	});

	it("status 只报当前档位与三档含义", async () => {
		writeMode("loose");
		const { ctx, notices } = fakeCtx();
		await networkCommandHandler("status", ctx, { findYad: () => null });
		assert.match(noticeText(notices), /network 审核强度：loose/);
		assert.equal(readMode(), "loose");
	});
});

describe("yad 通道（假 runner）", () => {
	it("窗口里选一档 → 确认窗 → 写盘", async () => {
		const { runner, calls } = fakeYad([OK("loose|宽松：只拦往外送数据"), OK()]);
		const { ctx, notices } = fakeCtx({ agree: true });
		await networkCommandHandler("", ctx, guiDeps(runner));
		assert.equal(readMode(), "loose");
		assert.match(calls[0]?.join(" ") ?? "", /--list/);
		assert.match(calls[1]?.join(" ") ?? "", /放宽 network 审核/);
		assert.match(noticeText(notices), /已设为 loose/);
	});

	it("窗口按内容给尺寸：三行字的小窗不给 920x640", async () => {
		const { runner, calls } = fakeYad([OK("loose|宽松"), OK()]);
		const { ctx } = fakeCtx({ agree: true });
		await networkCommandHandler("", ctx, guiDeps(runner));
		const pick = calls[0]?.join(" ") ?? "";
		assert.match(pick, /--width=560/, "选择窗要小");
		assert.match(pick, /--height=240/);
		assert.doesNotMatch(pick, /--width=920/);
		// 确认窗字多一些，但也不该是路径表格那个尺寸
		const confirm = calls[1]?.join(" ") ?? "";
		assert.match(confirm, /--width=700/);
		assert.match(confirm, /--height=420/);
	});

	it("status 的小窗同样不占满屏", async () => {
		const { runner, calls } = fakeYad([OK()]);
		const { ctx } = fakeCtx();
		await networkCommandHandler("status", ctx, guiDeps(runner));
		assert.match(calls[0]?.join(" ") ?? "", /--width=660/);
	});

	it("窗口里关掉 → 不写盘", async () => {
		const { runner } = fakeYad([CANCEL]);
		const { ctx, notices } = fakeCtx();
		await networkCommandHandler("", ctx, guiDeps(runner));
		assert.equal(readMode(), "whitelist");
		assert.match(noticeText(notices), /已取消/);
	});

	it("确认窗被取消 → 不写盘", async () => {
		const { runner } = fakeYad([OK("off|关闭网络审核"), CANCEL]);
		const { ctx, notices } = fakeCtx();
		await networkCommandHandler("", ctx, guiDeps(runner));
		assert.equal(readMode(), "whitelist");
		assert.match(noticeText(notices), /已取消/);
	});

	it("窗口拉不起来 → 回退逐项提问，功能一致", async () => {
		const { runner } = fakeYad(() => ({ code: 1, stdout: "", stderr: "cannot open display: \n" }));
		const { ctx, confirms, notices, selects } = fakeCtx({ choice: "loose", agree: true });
		await networkCommandHandler("", ctx, guiDeps(runner));
		assert.equal(selects.length, 1, "回退到 ctx.ui.select");
		assert.equal(confirms.length, 1);
		assert.equal(readMode(), "loose");
		assert.match(noticeText(notices), /yad 窗口拉不起来/);
	});
});

describe("文案", () => {
	it("确认正文写清方向、后果与落点", () => {
		const body = confirmBody("loose", FILE, "whitelist");
		assert.match(body, /当前：whitelist/);
		assert.match(body, /改为：loose/);
		assert.match(body, new RegExp(FILE));
		assert.match(body, /只由人类来改/);
	});

	it("用法里写明作用范围：只管 worker 出网这一维", () => {
		assert.match(NETWORK_USAGE, /worker（subagent）出网这一维/);
		assert.match(NETWORK_USAGE, /主 agent 的 bash 从不卡 network/);
	});

	it("status 文案标出当前档", () => {
		assert.match(networkStatusText(), /▶ whitelist/);
	});
});

// 文件不存在时 status 也要说清默认档
describe("默认档", () => {
	it("配置文件缺失 → 按 whitelist 报", async () => {
		rmSync(FILE, { force: true });
		assert.equal(existsSync(FILE), false);
		const { ctx, notices } = fakeCtx();
		await networkCommandHandler("status", ctx, { findYad: () => null });
		assert.match(noticeText(notices), /network 审核强度：whitelist/);
	});
});
