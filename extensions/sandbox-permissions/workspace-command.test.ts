// workspace-command.test.ts — /sandbox:workspaces（副工作区管理）纯逻辑与 handler 测试
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/workspace-command.test.ts
//
// 用 setPathsFileForTest 把读写指向临时文件，绝不碰真实的 sandbox-paths.json。
// handler 用假 ctx.ui（notify/select/input/confirm）验证交互路径，含无 UI 的 fail-safe。

import assert from "node:assert/strict";
import { describe, it, after, beforeEach } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadSandboxPaths, normalizeDir, saveSandboxPaths, setPathsFileForTest } from "./paths.ts";
import {
	formatWorkspaceList,
	parseWorkspaceArgs,
	resolveRemoveTarget,
	validateWorkspaceDir,
	workspaceArgumentCompletions,
	workspaceCommandHandler,
	type WorkspaceCommandContext,
} from "./workspace-command.ts";

const tmp = mkdtempSync(join(tmpdir(), "sandbox-workspace-cmd-test-"));
const jsonFile = join(tmp, "sandbox-paths.json");
setPathsFileForTest(jsonFile);
after(() => rmSync(tmp, { recursive: true, force: true }));

// ── 假 ctx：记录 notify / confirm，select 与 input 按预设作答 ──
interface FakeOptions {
	agree?: boolean; // confirm 的答复（默认 false，模拟用户取消）
	typed?: string; // input 的输入
	choice?: string; // select 的选择（须匹配某个选项的子串）
	hasUI?: boolean;
}

function fakeCtx(opts: FakeOptions = {}) {
	const notices: { message: string; type?: string }[] = [];
	const confirms: { title: string; message: string }[] = [];
	const selects: { title: string; options: string[] }[] = [];
	let inputCount = 0;
	const ui = {
		notify: (message: string, type?: "info" | "warning" | "error") => {
			notices.push({ message, type });
		},
		confirm: async (title: string, message: string) => {
			confirms.push({ title, message });
			return opts.agree ?? false;
		},
		input: async () => {
			inputCount++;
			return opts.typed;
		},
		select: async (title: string, options: string[]) => {
			selects.push({ title, options });
			if (opts.choice === undefined) return undefined;
			return options.find((o) => o.includes(opts.choice as string));
		},
	};
	const ctx: WorkspaceCommandContext = { ui, hasUI: opts.hasUI ?? true };
	return { ctx, notices, confirms, selects, inputCount: () => inputCount };
}

/** 最新一条 notify 文本 */
function last(notices: { message: string }[]): string {
	return notices.at(-1)?.message ?? "";
}

beforeEach(() => {
	saveSandboxPaths({ allowDirs: [], blockDirs: [] });
});

describe("parseWorkspaceArgs", () => {
	it("空参数 / list 系列 → 列出", () => {
		assert.deepEqual(parseWorkspaceArgs(""), { kind: "list", target: "" });
		assert.deepEqual(parseWorkspaceArgs("   "), { kind: "list", target: "" });
		assert.deepEqual(parseWorkspaceArgs("list"), { kind: "list", target: "" });
		assert.deepEqual(parseWorkspaceArgs("ls"), { kind: "list", target: "" });
	});

	it("add / remove 带目标（路径可含空格，不切分）", () => {
		assert.deepEqual(parseWorkspaceArgs("add /tmp/build"), { kind: "add", target: "/tmp/build" });
		assert.deepEqual(parseWorkspaceArgs("add ~/work/my dir"), { kind: "add", target: "~/work/my dir" });
		assert.deepEqual(parseWorkspaceArgs("remove 2"), { kind: "remove", target: "2" });
		assert.deepEqual(parseWorkspaceArgs("rm /tmp/build"), { kind: "remove", target: "/tmp/build" });
	});

	it("add / remove 无目标 → target 为空（走交互）", () => {
		assert.deepEqual(parseWorkspaceArgs("add"), { kind: "add", target: "" });
		assert.deepEqual(parseWorkspaceArgs("remove"), { kind: "remove", target: "" });
	});

	it("裸路径视作 add", () => {
		assert.deepEqual(parseWorkspaceArgs("/tmp/build"), { kind: "add", target: "/tmp/build" });
		assert.deepEqual(parseWorkspaceArgs("~/scratch"), { kind: "add", target: "~/scratch" });
	});

	it("help 与未知子命令", () => {
		assert.deepEqual(parseWorkspaceArgs("help"), { kind: "help", target: "" });
		assert.deepEqual(parseWorkspaceArgs("--help"), { kind: "help", target: "" });
		assert.deepEqual(parseWorkspaceArgs("frobnicate"), { kind: "help", target: "", unknown: "frobnicate" });
	});
});

describe("validateWorkspaceDir 护栏", () => {
	it("拒绝根目录", () => {
		const r = validateWorkspaceDir("/");
		assert.equal(r.ok, false);
		assert.match(r.ok === false ? r.reason : "", /根目录/);
	});

	it("拒绝家目录本身（含 ~ 展开）", () => {
		for (const raw of [homedir(), "~", "~/", `${homedir()}/.`]) {
			const r = validateWorkspaceDir(raw);
			assert.equal(r.ok, false, `${raw} 应被拒绝`);
		}
	});

	it("家目录的子目录合法", () => {
		const r = validateWorkspaceDir("~/work/scratch");
		assert.equal(r.ok, true);
		assert.equal(r.ok === true ? r.dir : "", join(homedir(), "work/scratch"));
	});

	it("规范化：去尾斜杠、消 ..、去首尾空白", () => {
		const r = validateWorkspaceDir("  /tmp/build/../out/  ");
		assert.equal(r.ok, true);
		assert.equal(r.ok === true ? r.dir : "", "/tmp/out");
	});

	it("空串拒绝", () => {
		assert.equal(validateWorkspaceDir("").ok, false);
		assert.equal(validateWorkspaceDir("   ").ok, false);
	});
});

describe("formatWorkspaceList", () => {
	it("编号展示，含存储路径与用法", () => {
		const text = formatWorkspaceList(["/tmp/a", "/tmp/b"], "/x/sandbox-paths.json");
		assert.match(text, /：2 个/);
		assert.match(text, /1\. \/tmp\/a/);
		assert.match(text, /2\. \/tmp\/b/);
		assert.match(text, /\/x\/sandbox-paths\.json/);
		assert.match(text, /add <目录>/);
	});

	it("空列表有明确提示", () => {
		assert.match(formatWorkspaceList([], "/x/sandbox-paths.json"), /（空）/);
	});
});

describe("resolveRemoveTarget", () => {
	const dirs = ["/tmp/a", "/tmp/b"];

	it("序号按 1 起", () => {
		assert.deepEqual(resolveRemoveTarget("1", dirs), { ok: true, dir: "/tmp/a" });
		assert.deepEqual(resolveRemoveTarget("2", dirs), { ok: true, dir: "/tmp/b" });
	});

	it("序号越界 / 0 拒绝", () => {
		assert.equal(resolveRemoveTarget("3", dirs).ok, false);
		assert.equal(resolveRemoveTarget("0", dirs).ok, false);
	});

	it("路径须在列表内（先规范化）", () => {
		assert.deepEqual(resolveRemoveTarget("/tmp/a/", dirs), { ok: true, dir: "/tmp/a" });
		assert.equal(resolveRemoveTarget("/tmp/c", dirs).ok, false);
	});

	it("空目标拒绝", () => {
		assert.equal(resolveRemoveTarget("  ", dirs).ok, false);
	});
});

describe("handler：list", () => {
	it("列出当前 allowDirs 与存储位置", async () => {
		saveSandboxPaths({ allowDirs: ["/tmp/a"], blockDirs: [] });
		const { ctx, notices } = fakeCtx();
		await workspaceCommandHandler("", ctx);
		assert.equal(notices.length, 1);
		assert.match(last(notices), /\/tmp\/a/);
		assert.match(last(notices), /sandbox-paths\.json/);
	});

	it("未知子命令 → warning 并带用法", async () => {
		const { ctx, notices } = fakeCtx();
		await workspaceCommandHandler("frobnicate", ctx);
		assert.equal(notices.at(-1)?.type, "warning");
		assert.match(last(notices), /未知子命令/);
		assert.match(last(notices), /用法/);
	});
});

describe("handler：add", () => {
	it("确认后写盘 + notify", async () => {
		const { ctx, notices, confirms } = fakeCtx({ agree: true });
		await workspaceCommandHandler("add /tmp/build", ctx);
		assert.equal(confirms.length, 1);
		assert.match(confirms[0].title, /\/tmp\/build/);
		assert.match(confirms[0].message, /长期可写根/);
		assert.deepEqual(loadSandboxPaths().allowDirs, ["/tmp/build"]);
		assert.match(last(notices), /已添加副工作区/);
	});

	it("取消确认 → 不写盘", async () => {
		const { ctx, notices } = fakeCtx({ agree: false });
		await workspaceCommandHandler("add /tmp/build", ctx);
		assert.deepEqual(loadSandboxPaths().allowDirs, []);
		assert.match(last(notices), /已取消/);
	});

	it("根目录 / 家目录本身：报错且不弹确认、不写盘", async () => {
		for (const bad of ["/", "~"]) {
			const { ctx, notices, confirms } = fakeCtx({ agree: true });
			await workspaceCommandHandler(`add ${bad}`, ctx);
			assert.equal(confirms.length, 0, `${bad} 不该弹确认`);
			assert.equal(notices.at(-1)?.type, "error");
			assert.deepEqual(loadSandboxPaths().allowDirs, []);
		}
	});

	it("重复添加：提示已存在，不再弹确认", async () => {
		saveSandboxPaths({ allowDirs: ["/tmp/build"], blockDirs: [] });
		const { ctx, notices, confirms } = fakeCtx({ agree: true });
		await workspaceCommandHandler("add /tmp/build/", ctx);
		assert.equal(confirms.length, 0);
		assert.match(last(notices), /已在副工作区列表/);
		assert.deepEqual(loadSandboxPaths().allowDirs, ["/tmp/build"]);
	});

	it("无参数：走 input 输入", async () => {
		const { ctx, confirms } = fakeCtx({ agree: true, typed: "/tmp/typed" });
		await workspaceCommandHandler("add", ctx);
		assert.equal(confirms.length, 1);
		assert.deepEqual(loadSandboxPaths().allowDirs, ["/tmp/typed"]);
	});

	it("无参数 + input 取消 → 不写盘", async () => {
		const { ctx, notices } = fakeCtx({ agree: true, typed: undefined });
		await workspaceCommandHandler("add", ctx);
		assert.match(last(notices), /已取消/);
		assert.deepEqual(loadSandboxPaths().allowDirs, []);
	});

	it("hasUI=false：fail-safe，不写盘", async () => {
		const { ctx, notices, confirms } = fakeCtx({ agree: true, hasUI: false });
		await workspaceCommandHandler("add /tmp/build", ctx);
		assert.equal(confirms.length, 0);
		assert.equal(notices.at(-1)?.type, "error");
		assert.deepEqual(loadSandboxPaths().allowDirs, []);
	});

	it("无参数 + hasUI=false：要求带参数，不挂起", async () => {
		const { ctx, notices, inputCount } = fakeCtx({ hasUI: false, typed: "/tmp/x" });
		await workspaceCommandHandler("add", ctx);
		assert.equal(inputCount(), 0);
		assert.match(last(notices), /请带参数/);
	});
});

describe("handler：remove", () => {
	it("按序号移除", async () => {
		saveSandboxPaths({ allowDirs: ["/tmp/a", "/tmp/b"], blockDirs: [] });
		const { ctx, notices } = fakeCtx();
		await workspaceCommandHandler("remove 1", ctx);
		assert.deepEqual(loadSandboxPaths().allowDirs, ["/tmp/b"]);
		assert.match(last(notices), /已移除副工作区：\/tmp\/a/);
	});

	it("按路径移除（规范化后匹配）", async () => {
		saveSandboxPaths({ allowDirs: ["/tmp/a"], blockDirs: [] });
		const { ctx } = fakeCtx();
		await workspaceCommandHandler("remove /tmp/a/", ctx);
		assert.deepEqual(loadSandboxPaths().allowDirs, []);
	});

	it("不在列表 / 越界 → 报错且不动文件", async () => {
		saveSandboxPaths({ allowDirs: ["/tmp/a"], blockDirs: [] });
		for (const arg of ["remove /tmp/zzz", "remove 9"]) {
			const { ctx, notices } = fakeCtx();
			await workspaceCommandHandler(arg, ctx);
			assert.equal(notices.at(-1)?.type, "error");
			assert.deepEqual(loadSandboxPaths().allowDirs, ["/tmp/a"]);
		}
	});

	it("无参数：select 列表里挑一个", async () => {
		saveSandboxPaths({ allowDirs: ["/tmp/a", "/tmp/b"], blockDirs: [] });
		const { ctx, selects, notices } = fakeCtx({ choice: "/tmp/b" });
		await workspaceCommandHandler("remove", ctx);
		assert.equal(selects.length, 1);
		assert.deepEqual(selects[0].options, ["1. /tmp/a", "2. /tmp/b", "❌ 取消"]);
		assert.deepEqual(loadSandboxPaths().allowDirs, ["/tmp/a"]);
		assert.match(last(notices), /已移除副工作区：\/tmp\/b/);
	});

	it("无参数 + 选择取消 → 不写盘", async () => {
		saveSandboxPaths({ allowDirs: ["/tmp/a"], blockDirs: [] });
		const { ctx, notices } = fakeCtx({ choice: "❌" });
		await workspaceCommandHandler("remove", ctx);
		assert.match(last(notices), /已取消/);
		assert.deepEqual(loadSandboxPaths().allowDirs, ["/tmp/a"]);
	});

	it("列表为空：直接提示", async () => {
		const { ctx, notices, selects } = fakeCtx();
		await workspaceCommandHandler("remove", ctx);
		assert.equal(selects.length, 0);
		assert.match(last(notices), /为空/);
	});

	it("hasUI=false + 无参数：要求带参数", async () => {
		saveSandboxPaths({ allowDirs: ["/tmp/a"], blockDirs: [] });
		const { ctx, notices, selects } = fakeCtx({ hasUI: false });
		await workspaceCommandHandler("remove", ctx);
		assert.equal(selects.length, 0);
		assert.match(last(notices), /请带参数/);
	});
});

describe("handler：写入的文件内容", () => {
	it("只改 allowDirs，blockDirs 原样保留", async () => {
		saveSandboxPaths({ allowDirs: [], blockDirs: ["/home/secret"] });
		const { ctx } = fakeCtx({ agree: true });
		await workspaceCommandHandler("add /tmp/build", ctx);
		const doc = JSON.parse(readFileSync(jsonFile, "utf8")) as { allowDirs: string[]; blockDirs: string[] };
		assert.deepEqual(doc.allowDirs, ["/tmp/build"]);
		assert.deepEqual(doc.blockDirs, ["/home/secret"]);
	});

	it("写入的是规范化路径（~ 展开、去 ..）", async () => {
		const { ctx } = fakeCtx({ agree: true });
		await workspaceCommandHandler("add ~/work/../work/out/", ctx);
		assert.deepEqual(loadSandboxPaths().allowDirs, [join(homedir(), "work/out")]);
		assert.equal(normalizeDir("~/work/../work/out/"), join(homedir(), "work/out"));
	});
});

describe("参数补全", () => {
	it("首词补全子命令", () => {
		assert.deepEqual(
			workspaceArgumentCompletions("").map((c) => c.value),
			["list", "add", "remove", "help"],
		);
		assert.deepEqual(workspaceArgumentCompletions("rem").map((c) => c.value), ["remove"]);
	});

	it("remove 后补全现有副工作区", () => {
		saveSandboxPaths({ allowDirs: ["/tmp/a", "/opt/b"], blockDirs: [] });
		assert.deepEqual(workspaceArgumentCompletions("remove /tmp").map((c) => c.value), ["remove /tmp/a"]);
		assert.deepEqual(workspaceArgumentCompletions("add /tmp"), []);
	});
});
