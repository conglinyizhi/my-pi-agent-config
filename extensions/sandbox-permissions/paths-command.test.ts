// paths-command.test.ts — /sandbox:paths 的纯逻辑、TUI 回退与 yad 通道（假 runner）
//
// 跑法：node --test --experimental-strip-types extensions/sandbox-permissions/paths-command.test.ts
//
// 约定：
//   - 读写指向 mktemp 目录里的 sandbox-paths.json，绝不碰真实配置
//   - yad 一律用**假 runner**：真 yad 是阻塞式、等人点的窗口，测试里不许拉起来
//     （realYadRunner 另有 NODE_TEST_CONTEXT 兜底，漏注入也不会挂在窗口上）
//   - TUI 路径用假 ctx.ui（notify/select/input/confirm），断言的是「实际调了哪个方法、传了什么」

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setPathsFileForTest } from "./paths.ts";
import { resetTrustedCache, setTrustedProgramsFile } from "./trusted.ts";
import { PATHS_USAGE, parsePathsArgs, pathsArgumentCompletions, pathsCommandHandler, type PathsCommandContext } from "./paths-command.ts";
import type { YadResult, YadRunner } from "./yad-paths.ts";

const tmp = mkdtempSync(join(tmpdir(), "sandbox-paths-cmd-test-"));
const jsonFile = join(tmp, "sandbox-paths.json");
setPathsFileForTest(jsonFile);
setTrustedProgramsFile(jsonFile);
after(() => rmSync(tmp, { recursive: true, force: true }));

function writeConfig(doc: Record<string, unknown>): void {
	writeFileSync(jsonFile, JSON.stringify(doc, null, 2) + "\n");
	resetTrustedCache();
}

function readConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(jsonFile, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
	writeConfig({ allowDirs: [], blockDirs: [], trustedProgramDirs: [] });
});

// ── 假 ctx.ui：记录调用，select/input 按队列作答 ──
interface FakeOptions {
	/** confirm 的答复（默认 false = 用户取消） */
	agree?: boolean;
	/** select 的答案队列（按子串匹配选项），用完后回落到 choice */
	choices?: string[];
	choice?: string;
	/** input 的答案队列，用完后回落到 typed */
	inputs?: string[];
	typed?: string;
	hasUI?: boolean;
}

function fakeCtx(opts: FakeOptions = {}) {
	const notices: { message: string; type?: string }[] = [];
	const confirms: { title: string; message: string }[] = [];
	const selects: { title: string; options: string[] }[] = [];
	const inputs: string[] = [];
	const choices = [...(opts.choices ?? [])];
	const typed = [...(opts.inputs ?? [])];
	const ui = {
		notify: (message: string, type?: "info" | "warning" | "error") => {
			notices.push({ message, type });
		},
		confirm: async (title: string, message: string) => {
			confirms.push({ title, message });
			return opts.agree ?? false;
		},
		input: async (title: string) => {
			inputs.push(title);
			return typed.shift() ?? opts.typed;
		},
		select: async (title: string, options: string[]) => {
			selects.push({ title, options });
			const want = choices.length > 0 ? choices.shift() : opts.choice;
			if (want === undefined) return undefined;
			return options.find((o) => o.includes(want as string));
		},
	};
	const ctx: PathsCommandContext = { ui, hasUI: opts.hasUI ?? true };
	return { ctx, notices, confirms, selects, inputs };
}

function last(notices: { message: string }[]): string {
	return notices.at(-1)?.message ?? "";
}

function noticeText(notices: { message: string }[]): string {
	return notices.map((n) => n.message).join("\n");
}

// ── 假 yad runner ──
/** 按顺序出结果；用完后重复最后一个。记录每次调用的 argv。 */
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
const NO_DISPLAY: YadResult = { code: 1, stdout: "", stderr: "cannot open display: \n" };

/** 图形通道可用（有 yad、有 DISPLAY），runner 为假的 */
const guiDeps = (runner: YadRunner) => ({
	runner,
	findYad: () => "/usr/bin/yad",
	hasDisplay: () => true,
	env: {} as NodeJS.ProcessEnv,
});

/** 无图形：有 yad 但没 DISPLAY */
const noDisplayDeps = (runner: YadRunner) => ({
	runner,
	findYad: () => "/usr/bin/yad",
	hasDisplay: () => false,
	env: {} as NodeJS.ProcessEnv,
});

/** 没装 yad */
const noYadDeps = (runner: YadRunner) => ({
	runner,
	findYad: () => null,
	hasDisplay: () => true,
	env: {} as NodeJS.ProcessEnv,
});

/** 参数里找某个以 prefix 开头的项 */
function argOf(args: string[], prefix: string): string | undefined {
	return args.find((a) => a.startsWith(prefix));
}

// ═══════════════════════════════════════════════════

describe("parsePathsArgs", () => {
	it("空参数：列出 + help + 交互菜单", () => {
		assert.deepEqual(parsePathsArgs(""), { kind: "list", target: "", withHelp: true });
		assert.deepEqual(parsePathsArgs("   "), { kind: "list", target: "", withHelp: true });
	});

	it("list 系列：只列不追问", () => {
		for (const w of ["list", "ls", "show"]) {
			assert.deepEqual(parsePathsArgs(w), { kind: "list", target: "" });
		}
	});

	it("add / remove 带类型与目标（目标可含空格）", () => {
		assert.deepEqual(parsePathsArgs("add trusted /opt/tools"), {
			kind: "add",
			key: "trustedProgramDirs",
			target: "/opt/tools",
		});
		assert.deepEqual(parsePathsArgs("add allow ~/my work/out"), {
			kind: "add",
			key: "allowDirs",
			target: "~/my work/out",
		});
		assert.deepEqual(parsePathsArgs("remove block 2"), { kind: "remove", key: "blockDirs", target: "2" });
		assert.deepEqual(parsePathsArgs("rm allow /tmp/a"), { kind: "remove", key: "allowDirs", target: "/tmp/a" });
	});

	it("只给类型不给目标：目标为空，走交互", () => {
		assert.deepEqual(parsePathsArgs("add trusted"), { kind: "add", key: "trustedProgramDirs", target: "" });
		assert.deepEqual(parsePathsArgs("remove block"), { kind: "remove", key: "blockDirs", target: "" });
	});

	it("类型词不认识 / 裸路径：都要求显式写类型", () => {
		assert.deepEqual(parsePathsArgs("add bogus /tmp/x"), { kind: "add", target: "", unknown: "bogus" });
		assert.deepEqual(parsePathsArgs("/tmp/build"), { kind: "help", target: "", needKind: "/tmp/build" });
		assert.deepEqual(parsePathsArgs("add /tmp/build"), { kind: "add", target: "", unknown: "/tmp/build" });
	});

	it("未知子命令 / help", () => {
		assert.deepEqual(parsePathsArgs("frobnicate"), { kind: "help", target: "", unknown: "frobnicate" });
		assert.deepEqual(parsePathsArgs("help"), { kind: "help", target: "" });
		assert.deepEqual(parsePathsArgs("--help"), { kind: "help", target: "" });
	});
});

describe("TUI 回退：列出", () => {
	it("list：一条 notify，含三类字段名与用法，不动配置", async () => {
		writeConfig({ allowDirs: ["/tmp/a"], blockDirs: [], trustedProgramDirs: [] });
		const { ctx, notices, selects, confirms } = fakeCtx();
		await pathsCommandHandler("list", ctx, noYadDeps(fakeYad([]).runner));
		assert.equal(selects.length, 0);
		assert.equal(confirms.length, 0);
		assert.match(last(notices), /trustedProgramDirs/);
		assert.match(last(notices), /allowDirs/);
		assert.match(last(notices), /blockDirs/);
		assert.match(last(notices), /\/tmp\/a/);
		assert.match(last(notices), /来源：/);
		assert.deepEqual(readConfig().allowDirs, ["/tmp/a"]);
	});

	it("无参数 + 无交互界面：给 help 文案，不挂起", async () => {
		const { ctx, notices, selects } = fakeCtx({ hasUI: false });
		await pathsCommandHandler("", ctx, noYadDeps(fakeYad([]).runner));
		assert.equal(selects.length, 0);
		assert.match(noticeText(notices), /用法：/);
		assert.match(noticeText(notices), /sandbox:paths add trusted/);
	});

	it("无参数 + 有界面：先列出，再逐个问类型与动作", async () => {
		const { ctx, notices, selects, confirms } = fakeCtx({
			choices: ["trusted", "添加"],
			inputs: ["/opt/tools"],
			agree: true,
		});
		await pathsCommandHandler("", ctx, noYadDeps(fakeYad([]).runner));
		assert.match(noticeText(notices), /trustedProgramDirs/);
		assert.equal(selects.length, 2);
		assert.match(selects[0].title, /哪一类配置/);
		assert.deepEqual(selects[0].options.slice(0, 3), [
			"trusted — 可信程序目录（当前 0 个）",
			"allow — 副工作区（长期可写根）（当前 0 个）",
			"block — 黑名单（当前 0 个）",
		]);
		assert.match(selects[1].title, /可信程序目录/);
		assert.deepEqual(selects[1].options, ["添加", "移除", "❌ 取消"]);
		assert.equal(confirms.length, 1);
		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/tools"]);
	});

	it("无参数 + 类型选择取消：不写任何东西", async () => {
		const { ctx, notices, confirms } = fakeCtx({ choices: ["❌"] });
		await pathsCommandHandler("", ctx, noYadDeps(fakeYad([]).runner));
		assert.equal(confirms.length, 0);
		assert.match(last(notices), /已取消/);
		assert.deepEqual(readConfig().trustedProgramDirs, []);
	});
});

describe("TUI 回退：添加", () => {
	it("trusted：确认文案写明后果「放宽对 AI 命令的审核」，确认后写 trustedProgramDirs", async () => {
		const { ctx, notices, confirms } = fakeCtx({ agree: true });
		await pathsCommandHandler("add trusted /opt/tools", ctx, noYadDeps(fakeYad([]).runner));
		assert.equal(confirms.length, 1);
		assert.match(confirms[0].title, /放宽对 AI 命令的审核/);
		assert.match(confirms[0].message, /放宽对 AI 命令的审核/);
		assert.match(confirms[0].message, /人类的权限/);
		assert.match(confirms[0].message, /trustedProgramDirs/);
		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/tools"]);
		assert.deepEqual(readConfig().allowDirs, [], "不许顺手写 allowDirs");
		assert.match(last(notices), /已添加可信程序目录：\/opt\/tools/);
		assert.match(noticeText(notices), /即时生效/);
	});

	it("trusted：取消确认 → 不写盘", async () => {
		const { ctx, notices } = fakeCtx({ agree: false });
		await pathsCommandHandler("add trusted /opt/tools", ctx, noYadDeps(fakeYad([]).runner));
		assert.deepEqual(readConfig().trustedProgramDirs, []);
		assert.match(last(notices), /已取消，未写入/);
	});

	it("allow：沿用副工作区那套确认形态（长期可写根）", async () => {
		const { ctx, notices, confirms } = fakeCtx({ agree: true });
		await pathsCommandHandler("add allow /tmp/scratch", ctx, noYadDeps(fakeYad([]).runner));
		assert.match(confirms[0].title, /副工作区/);
		assert.match(confirms[0].message, /长期可写根/);
		assert.doesNotMatch(confirms[0].message, /放宽对 AI 命令的审核/);
		assert.deepEqual(readConfig().allowDirs, ["/tmp/scratch"]);
		assert.deepEqual(readConfig().trustedProgramDirs, []);
		assert.match(last(notices), /已添加副工作区/);
	});

	it("block：写 blockDirs，确认里写明「敏感」", async () => {
		const { ctx, confirms } = fakeCtx({ agree: true });
		await pathsCommandHandler("add block /home/x/secret", ctx, noYadDeps(fakeYad([]).runner));
		assert.match(confirms[0].message, /敏感/);
		assert.deepEqual(readConfig().blockDirs, ["/home/x/secret"]);
	});

	it("护栏：/ 与家目录本身报错，不弹确认、不写盘", async () => {
		for (const bad of ["/", "~"]) {
			const { ctx, notices, confirms } = fakeCtx({ agree: true });
			await pathsCommandHandler(`add trusted ${bad}`, ctx, noYadDeps(fakeYad([]).runner));
			assert.equal(confirms.length, 0, `${bad} 不该弹确认`);
			assert.equal(notices.at(-1)?.type, "error");
			assert.deepEqual(readConfig().trustedProgramDirs, []);
		}
	});

	it("重复添加：提示已存在，不再弹确认", async () => {
		writeConfig({ allowDirs: [], blockDirs: [], trustedProgramDirs: ["/opt/tools"] });
		const { ctx, notices, confirms } = fakeCtx({ agree: true });
		await pathsCommandHandler("add trusted /opt/tools/", ctx, noYadDeps(fakeYad([]).runner));
		assert.equal(confirms.length, 0);
		assert.match(last(notices), /已在可信程序目录列表里/);
		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/tools"]);
	});

	it("无目标：走 input；输入为空视作取消", async () => {
		const first = fakeCtx({ agree: true, typed: "/opt/typed" });
		await pathsCommandHandler("add trusted", first.ctx, noYadDeps(fakeYad([]).runner));
		assert.equal(first.inputs.length, 1);
		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/typed"]);

		writeConfig({ allowDirs: [], blockDirs: [], trustedProgramDirs: [] });
		const second = fakeCtx({ agree: true, typed: undefined });
		await pathsCommandHandler("add trusted", second.ctx, noYadDeps(fakeYad([]).runner));
		assert.match(last(second.notices), /已取消/);
		assert.deepEqual(readConfig().trustedProgramDirs, []);
	});

	it("无交互界面：带参数也要二次确认，所以不写盘并报错", async () => {
		const { ctx, notices, confirms } = fakeCtx({ agree: true, hasUI: false });
		await pathsCommandHandler("add trusted /opt/tools", ctx, noYadDeps(fakeYad([]).runner));
		assert.equal(confirms.length, 0);
		assert.equal(notices.at(-1)?.type, "error");
		assert.match(last(notices), /无法二次确认/);
		assert.deepEqual(readConfig().trustedProgramDirs, []);
	});

	it("无交互界面 + 无目标：要求带参数，不挂起", async () => {
		const { ctx, notices, inputs } = fakeCtx({ hasUI: false, typed: "/opt/x" });
		await pathsCommandHandler("add trusted", ctx, noYadDeps(fakeYad([]).runner));
		assert.equal(inputs.length, 0);
		assert.match(last(notices), /请带参数/);
	});
});

describe("TUI 回退：移除", () => {
	it("按序号移除 trusted，只动这一项", async () => {
		writeConfig({ allowDirs: ["/tmp/a"], blockDirs: [], trustedProgramDirs: ["/opt/a", "/opt/b"] });
		const { ctx, notices } = fakeCtx();
		await pathsCommandHandler("remove trusted 1", ctx, noYadDeps(fakeYad([]).runner));
		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/b"]);
		assert.deepEqual(readConfig().allowDirs, ["/tmp/a"]);
		assert.match(last(notices), /已移除可信程序目录：\/opt\/a/);
	});

	it("无目标：select 从列表里挑；取消则不写", async () => {
		writeConfig({ allowDirs: ["/tmp/a", "/tmp/b"], blockDirs: [], trustedProgramDirs: [] });
		const picked = fakeCtx({ choice: "/tmp/b" });
		await pathsCommandHandler("remove allow", picked.ctx, noYadDeps(fakeYad([]).runner));
		assert.deepEqual(picked.selects[0].options, ["1. /tmp/a", "2. /tmp/b", "❌ 取消"]);
		assert.deepEqual(readConfig().allowDirs, ["/tmp/a"]);

		const cancelled = fakeCtx({ choice: "❌" });
		await pathsCommandHandler("remove allow", cancelled.ctx, noYadDeps(fakeYad([]).runner));
		assert.match(last(cancelled.notices), /已取消/);
		assert.deepEqual(readConfig().allowDirs, ["/tmp/a"]);
	});

	it("越界序号 / 不在列表：报错且不动文件", async () => {
		writeConfig({ allowDirs: ["/tmp/a"], blockDirs: [], trustedProgramDirs: [] });
		for (const arg of ["remove allow 9", "remove allow /tmp/zzz"]) {
			const { ctx, notices } = fakeCtx();
			await pathsCommandHandler(arg, ctx, noYadDeps(fakeYad([]).runner));
			assert.equal(notices.at(-1)?.type, "error");
			assert.deepEqual(readConfig().allowDirs, ["/tmp/a"]);
		}
	});

	it("列表为空：提示，不弹 select", async () => {
		const { ctx, notices, selects } = fakeCtx();
		await pathsCommandHandler("remove trusted", ctx, noYadDeps(fakeYad([]).runner));
		assert.equal(selects.length, 0);
		assert.match(last(notices), /为空，无需移除/);
	});

	it("无交互界面 + 无目标：要求带参数", async () => {
		writeConfig({ allowDirs: ["/tmp/a"], blockDirs: [], trustedProgramDirs: [] });
		const { ctx, notices, selects } = fakeCtx({ hasUI: false });
		await pathsCommandHandler("remove allow", ctx, noYadDeps(fakeYad([]).runner));
		assert.equal(selects.length, 0);
		assert.match(last(notices), /请带参数/);
	});
});

describe("help / 参数错误", () => {
	it("未知子命令：warning + 用法", async () => {
		const { ctx, notices } = fakeCtx();
		await pathsCommandHandler("frobnicate", ctx, noYadDeps(fakeYad([]).runner));
		assert.equal(notices.at(-1)?.type, "warning");
		assert.match(noticeText(notices), /无法识别「frobnicate」/);
		assert.match(noticeText(notices), /trusted \| allow \| block/);
	});

	it("裸路径：提示缺少配置类型", async () => {
		const { ctx, notices } = fakeCtx();
		await pathsCommandHandler("/tmp/build", ctx, noYadDeps(fakeYad([]).runner));
		assert.match(noticeText(notices), /缺少配置类型/);
		assert.deepEqual(readConfig().trustedProgramDirs, []);
	});

	it("PATHS_USAGE 覆盖三类动作", () => {
		assert.match(PATHS_USAGE, /add trusted <目录>/);
		assert.match(PATHS_USAGE, /add allow <目录>/);
		assert.match(PATHS_USAGE, /add block <目录>/);
		assert.match(PATHS_USAGE, /remove <trusted\|allow\|block> <目录\|序号>/);
	});
});

describe("yad 通道（假 runner）", () => {
	it("正常选择：带目标时只弹一次确认，确认后写盘", async () => {
		const yad = fakeYad([OK("")]);
		const { ctx, notices } = fakeCtx();
		await pathsCommandHandler("add trusted /opt/tools", ctx, guiDeps(yad.runner));

		assert.equal(yad.calls.length, 1, "只该有一次 yad 调用（确认框）");
		const args = yad.calls[0];
		assert.match(argOf(args, "--title=") ?? "", /把 \/opt\/tools 加入可信程序目录？（会放宽对 AI 命令的审核）/);
		assert.ok(argOf(args, "--text=")?.includes("放宽对 AI 命令的审核"), "窗口正文必须写出后果");
		assert.equal(argOf(args, "--button=确认添加:0"), "--button=确认添加:0");
		assert.equal(argOf(args, "--button=取消:1"), "--button=取消:1");

		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/tools"]);
		assert.match(last(notices), /已添加可信程序目录/);
	});

	it("正常选择：无参数 → 菜单 → 表单 → 确认，三步走完", async () => {
		// 1 菜单选 trusted-add（stdout 是选中行：列用 | 连）；2 表单填目录；3 确认
		const yad = fakeYad([
			OK("trusted-add|把目录加入可信程序目录（会放宽对 AI 命令的审核）\n"),
			OK("/opt/tools|"),
			OK(""),
		]);
		const { ctx, notices } = fakeCtx();
		await pathsCommandHandler("", ctx, guiDeps(yad.runner));

		assert.equal(yad.calls.length, 3);
		assert.ok(yad.calls[0].includes("--list"), "第一步是列表菜单");
		assert.ok(yad.calls[0].includes("--column=操作"));
		assert.ok(yad.calls[1].includes("--form"), "第二步是表单");
		assert.ok(yad.calls[1].includes("--field=目录（支持 ~ 开头）:CE"));
		assert.ok(argOf(yad.calls[1], "--text=")?.includes("可信程序目录"));
		assert.ok(argOf(yad.calls[2], "--title=")?.includes("放宽对 AI 命令的审核"));

		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/tools"]);
		assert.match(last(notices), /已添加可信程序目录/);
	});

	it("正常选择：菜单选 allow-remove → 列表挑一条 → 移除", async () => {
		writeConfig({ allowDirs: ["/tmp/a", "/tmp/b"], blockDirs: [], trustedProgramDirs: [] });
		const yad = fakeYad([OK("allow-remove|从副工作区（长期可写根）移除\n"), OK("2|/tmp/b\n")]);
		const { ctx, notices } = fakeCtx();
		await pathsCommandHandler("", ctx, guiDeps(yad.runner));
		assert.equal(yad.calls.length, 2);
		assert.deepEqual(readConfig().allowDirs, ["/tmp/a"]);
		assert.match(last(notices), /已移除副工作区（长期可写根）：\/tmp\/b/);
	});

	it("重复条目：不弹确认、不重新写盘，窗口里给一句说明", async () => {
		writeConfig({ allowDirs: [], blockDirs: [], trustedProgramDirs: ["/opt/tools"] });
		const yad = fakeYad([OK("")]);
		const { ctx, notices } = fakeCtx();
		await pathsCommandHandler("add trusted /opt/tools/", ctx, guiDeps(yad.runner));
		assert.equal(yad.calls.length, 1, "只有一句说明窗，不弹确认");
		assert.match(argOf(yad.calls[0], "--title=") ?? "", /已在可信程序目录列表里/);
		assert.match(last(notices), /已在可信程序目录列表里/);
		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/tools"]);
	});

	it("护栏：/ 不在窗口里弹确认，只报错", async () => {
		const yad = fakeYad([OK("")]);
		const { ctx, notices } = fakeCtx();
		await pathsCommandHandler("add trusted /", ctx, guiDeps(yad.runner));
		assert.equal(yad.calls.length, 1);
		assert.match(argOf(yad.calls[0], "--title=") ?? "", /不能添加可信程序目录/);
		assert.equal(notices.at(-1)?.type, "error");
		assert.deepEqual(readConfig().trustedProgramDirs, []);
	});

	it("用户取消：确认框返回非 0 → 不写盘", async () => {
		const yad = fakeYad([CANCEL]);
		const { ctx, notices } = fakeCtx();
		await pathsCommandHandler("add trusted /opt/tools", ctx, guiDeps(yad.runner));
		assert.equal(yad.calls.length, 1);
		assert.deepEqual(readConfig().trustedProgramDirs, []);
		assert.match(last(notices), /已取消，未写入/);
	});

	it("用户取消：菜单关窗 → 不进入下一步", async () => {
		const yad = fakeYad([CANCEL]);
		const { ctx, notices } = fakeCtx();
		await pathsCommandHandler("", ctx, guiDeps(yad.runner));
		assert.equal(yad.calls.length, 1);
		assert.match(last(notices), /已取消/);
		assert.deepEqual(readConfig().allowDirs, []);
	});

	it("yad 不存在：不尝试启动，回退 TUI（input + confirm）", async () => {
		const yad = fakeYad([OK("")]);
		const { ctx, notices, confirms, inputs } = fakeCtx({ agree: true, typed: "/opt/tools" });
		await pathsCommandHandler("add trusted", ctx, noYadDeps(yad.runner));
		assert.equal(yad.calls.length, 0, "没装 yad 就不该 spawn");
		assert.equal(inputs.length, 1);
		assert.equal(confirms.length, 1);
		assert.match(noticeText(notices), /未找到 yad/);
		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/tools"]);
	});

	it("无 DISPLAY：不尝试启动，回退 TUI", async () => {
		const yad = fakeYad([OK("")]);
		const { ctx, notices, confirms } = fakeCtx({ agree: true });
		await pathsCommandHandler("add block /tmp/secret", ctx, noDisplayDeps(yad.runner));
		assert.equal(yad.calls.length, 0, "没有 DISPLAY 就不该 spawn");
		assert.equal(confirms.length, 1);
		assert.match(noticeText(notices), /DISPLAY/);
		assert.deepEqual(readConfig().blockDirs, ["/tmp/secret"]);
	});

	it("窗口拉不起来（stderr 说 cannot open display）：回退 TUI 并说明原因", async () => {
		const yad = fakeYad([NO_DISPLAY]);
		const { ctx, notices, confirms } = fakeCtx({ agree: true });
		await pathsCommandHandler("add allow /tmp/scratch", ctx, guiDeps(yad.runner));
		assert.equal(yad.calls.length, 1, "试了一次才回退");
		assert.equal(confirms.length, 1);
		assert.match(noticeText(notices), /拉不起来/);
		assert.deepEqual(readConfig().allowDirs, ["/tmp/scratch"]);
	});

	it("非交互会话（hasUI=false）：不开窗，走 TUI 的 fail-safe", async () => {
		const yad = fakeYad([OK("")]);
		const { ctx, notices, confirms } = fakeCtx({ agree: true, hasUI: false });
		await pathsCommandHandler("add trusted /opt/tools", ctx, guiDeps(yad.runner));
		assert.equal(yad.calls.length, 0);
		assert.equal(confirms.length, 0);
		assert.equal(notices.at(-1)?.type, "error");
		assert.deepEqual(readConfig().trustedProgramDirs, []);
	});

	it("显式 list：窗口只给概览，条目与说明不铺进弹窗", async () => {
		writeConfig({ allowDirs: ["/tmp/a"], blockDirs: [], trustedProgramDirs: [] });
		const yad = fakeYad([OK("")]);
		const { ctx } = fakeCtx();
		await pathsCommandHandler("list", ctx, guiDeps(yad.runner));
		assert.equal(yad.calls.length, 1);
		const text = argOf(yad.calls[0], "--text=") ?? "";
		assert.match(text, /沙箱路径配置/);
		assert.match(text, /可信程序目录：0 个（人类的权限）/);
		assert.match(text, /副工作区（长期可写根）：1 个/);
		assert.match(text, /黑名单：0 个/);
		// 条目与那套「来源/效果/范围」说明都不得进弹窗：
		// 之前铺满时窗口能长到两屏高，而这些内容在终端 print 里能选中、能翻页
		assert.ok(!text.includes("/tmp/a"), "条目不该铺进弹窗");
		assert.ok(!text.includes("autoReject"), "细节说明不该铺进弹窗");
	});
});

describe("参数补全", () => {
	it("首词补全子命令；第二词补全类型词", () => {
		assert.deepEqual(
			pathsArgumentCompletions("").map((c) => c.value),
			["list", "add", "remove", "help"],
		);
		assert.deepEqual(pathsArgumentCompletions("rem").map((c) => c.value), ["remove"]);
		assert.deepEqual(pathsArgumentCompletions("add t").map((c) => c.value), ["add trusted"]);
	});

	it("类型词之后补全现有条目", () => {
		writeConfig({ allowDirs: ["/tmp/a"], blockDirs: [], trustedProgramDirs: ["/opt/tools"] });
		assert.deepEqual(pathsArgumentCompletions("remove trusted /opt").map((c) => c.value), [
			"remove trusted /opt/tools",
		]);
		assert.deepEqual(pathsArgumentCompletions("add trusted /opt").map((c) => c.value), ["add trusted /opt/tools"]);
		assert.deepEqual(pathsArgumentCompletions("add trusted /zzz"), [], "匹配不上的目录不给提示");
	});
});

describe("真机验证：TUI 路径实际调了哪些 ui 方法", () => {
	it("add trusted（无 yad）：打印调用序列，参数逐条可见", async (t) => {
		const log: string[] = [];
		const ui = {
			notify: (message: string, type?: string) => {
				log.push(`notify(${type ?? "info"}) :: ${message.split("\n")[0]}`);
			},
			confirm: async (title: string, message: string) => {
				log.push(`confirm :: title=${title}`);
				log.push(`          body=${message.split("\n").join(" / ")}`);
				return true;
			},
			input: async (title: string, value?: string) => {
				log.push(`input :: title=${title} default=${JSON.stringify(value)}`);
				return undefined;
			},
			select: async (title: string, options: string[]) => {
				log.push(`select :: title=${title} options=${options.join(" , ")}`);
				return undefined;
			},
		};
		const ctx = { ui, hasUI: true } as unknown as PathsCommandContext;
		await pathsCommandHandler("add trusted /opt/tools", ctx, noYadDeps(fakeYad([]).runner));
		t.diagnostic(`ui 调用序列：\n${log.join("\n")}`);

		assert.equal(log.length, 4, `预期 不可用提示 → 确认(标题+正文) → 结果通知，实际：\n${log.join("\n")}`);
		assert.match(log[0], /^notify\(info\) :: 图形界面不可用（未找到 yad）/);
		assert.match(log[1], /^confirm :: title=把 \/opt\/tools 加入可信程序目录？（会放宽对 AI 命令的审核）/);
		assert.match(log[2], /放宽对 AI 命令的审核/);
		assert.match(log[3], /^notify\(info\) :: 已添加可信程序目录：\/opt\/tools/);
		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/tools"]);
	});

	it("无参数 + 无 yad：select 两项（类型、动作）后 input 目录", async (t) => {
		const log: string[] = [];
		let selectCount = 0;
		const ui = {
			notify: (message: string) => log.push(`notify :: ${message.split("\n")[0]}`),
			confirm: async (title: string) => {
				log.push(`confirm :: ${title}`);
				return true;
			},
			input: async (title: string) => {
				log.push(`input :: ${title}`);
				return "/opt/typed";
			},
			select: async (title: string, options: string[]) => {
				selectCount++;
				log.push(`select#${selectCount} :: ${title} → ${options.join(" , ")}`);
				return selectCount === 1 ? options[0] : options[0];
			},
		};
		const ctx = { ui, hasUI: true } as unknown as PathsCommandContext;
		await pathsCommandHandler("", ctx, noYadDeps(fakeYad([]).runner));
		t.diagnostic(`ui 调用序列：\n${log.join("\n")}`);

		assert.equal(selectCount, 2);
		assert.match(log[0], /^notify :: 沙箱路径配置（三类）：/, "先列出三类现状");
		assert.match(log[1], /^select#1 :: 改哪一类配置？/);
		assert.match(log[1], /trusted — 可信程序目录/);
		assert.match(log[2], /^select#2 :: 对「可信程序目录」做什么？/);
		assert.match(log[3], /^input :: 可信程序目录 · 要加入的目录（支持 ~ 开头）/);
		assert.match(log[4], /^confirm :: 把 \/opt\/typed 加入可信程序目录/);
		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/typed"]);
	});
});
