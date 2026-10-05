#!/usr/bin/env node
// scripts/ab-pack.ts — 把一个 git ref 构建到槽里
//
//   ab-pack <组件> [--ref <tag|sha|HEAD>] [--slot dev|head] [--runtime-root <dir>] [--json]
//
// 组件：
//   audit  从 ref 取 lib/ 与 extensions/（jiti 直接跑 ts，不需要构建步骤）
//   gui    从 ref 取 gui/electron，再加前端产物 dist
//
// 规矩（见 docs/plans/2026-10-05-ab-update.md）：
//   只往 dev / head 构建：stable 与 previous 只由晋升与回退动
//   脏工作区允许构建（狗粮要试未提交的东西），但 manifest 记 dirty，那样的产物不允许晋升
//   gui 槽暂时只支持从当前工作区构建：老 ref 的前端产物要单独装依赖再构建，
//     那一套（临时 worktree 加 pnpm install）等真需要回滚到老 GUI 时再做，现在不假装支持

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatManifest, type SlotManifest, componentPath, slotPath, type AbComponent, type AbSlot } from "../lib/ab-slots.ts";
import { archivePathsOf, flattenShellsInSlot, planPack } from "../lib/ab-pack.ts";
import { assertRuntimeRoot } from "../lib/ab-store.ts";

interface Options {
	runtimeRoot: string;
	ref: string;
	slot: AbSlot;
	json: boolean;
	/** 自举：允许落 stable/previous，给"从零开始"铺一条可回退的基线 */
	bootstrap: boolean;
}

function parseArgs(argv: string[]): { component?: string; options: Options } {
	const options: Options = {
		runtimeRoot: join(homedir(), ".pi", "runtime"),
		ref: "HEAD",
		slot: "dev",
		json: false,
		bootstrap: false,
	};
	let component: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--runtime-root") { options.runtimeRoot = argv[++index] ?? options.runtimeRoot; continue; }
		if (arg === "--ref") { options.ref = argv[++index] ?? options.ref; continue; }
		if (arg === "--slot") { options.slot = (argv[++index] ?? options.slot) as AbSlot; continue; }
		if (arg === "--json") { options.json = true; continue; }
		if (arg === "--bootstrap") { options.bootstrap = true; continue; }
		if (!component) component = arg;
	}
	return { component, options };
}

function git(args: string[], cwd: string): { ok: boolean; out: string } {
	const run = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { ok: run.status === 0, out: (run.stdout ?? "").trim() };
}

function repoRoot(): string {
	const run = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
	return (run.stdout ?? "").trim();
}

/** 从 ref 取指定路径解到目标目录：archive 出来的 tar 直接喂给 tar */
function extract(repo: string, ref: string, paths: string[], target: string): void {
	const archive = spawnSync("git", ["archive", "--format=tar", ref, ...paths], { cwd: repo, maxBuffer: 256 * 1024 * 1024 });
	if (archive.status !== 0) {
		throw new Error(`git archive 失败：${(archive.stderr ?? "").toString().trim()}`);
	}
	const untar = spawnSync("tar", ["-x", "-C", target], { input: archive.stdout });
	if (untar.status !== 0) {
		throw new Error(`解包失败：${(untar.stderr ?? "").toString().trim()}`);
	}
}

/** 读槽内 gui 自报的协议信息：用那棵树自己的 init-data.js，不拿当前仓库的顶替 */
function specOfSlot(slotDir: string): { protocol?: number; windows?: string[] } {
	const entry = join(slotDir, "gui", "electron", "init-data.js");
	if (!existsSync(entry)) return {};
	const code = `import("${entry}").then((m) => console.log(JSON.stringify(m.buildSpec())))`;
	const run = spawnSync("node", ["--input-type=module", "-e", code], { encoding: "utf8" });
	if (run.status !== 0) return {};
	try {
		const spec = JSON.parse((run.stdout ?? "").trim()) as { protocol?: number; windows?: string[] };
		return {
			...(typeof spec.protocol === "number" ? { protocol: spec.protocol } : {}),
			...(spec.windows ? { windows: spec.windows } : {}),
		};
	} catch {
		return {};
	}
}

function main(argv: string[]): number {
	const { component, options } = parseArgs(argv);
	if (!component) {
		console.error("用法：ab-pack <audit|gui> [--ref <tag|sha|HEAD>] [--slot dev|head] [--bootstrap] [--runtime-root <dir>] [--json]");
		return 2;
	}
	const runtimeRoot = assertRuntimeRoot(options.runtimeRoot);
	const repo = repoRoot();
	if (repo === "") {
		console.error("ab-pack: 不在 git 仓库里");
		return 1;
	}

	const shaRun = spawnSync("git", ["rev-parse", "--short", options.ref], { cwd: repo, encoding: "utf8" });
	const sha = shaRun.status === 0 ? (shaRun.stdout ?? "").trim() : undefined;
	const dirty = git(["status", "--porcelain"], repo).out !== "";
	const at = new Date().toISOString();

	const plan = planPack({
		component: component as AbComponent,
		ref: options.ref,
		slot: options.slot,
		dirty,
		at,
		bootstrap: options.bootstrap,
		...(sha ? { sha } : {}),
	});
	if (!plan.ok || !plan.manifest) {
		console.error(`ab-pack: ${plan.reason}`);
		return 1;
	}

	if (component === "gui" && options.ref !== "HEAD") {
		console.error("ab-pack: gui 槽暂不支持从老 ref 构建（老前端产物要单独装依赖再构建，另行处理）");
		return 1;
	}

	const target = slotPath(runtimeRoot, component as AbComponent, options.slot);
	try {
		mkdirSync(componentPath(runtimeRoot, component as AbComponent), { recursive: true });
		rmSync(target, { recursive: true, force: true });
		mkdirSync(target, { recursive: true });
		extract(repo, options.ref, archivePathsOf(component as AbComponent), target);
		// 槽里的入口不能是壳：摊平成对 impl 的重导出，否则壳加载壳会无限递归
		const flattened = component === "audit" ? flattenShellsInSlot(target) : [];
		// 槽里的代码要 import 宿主 pi 的包（@earendil-works/*）与扩展自己的依赖：
		// 把仓库的 node_modules 软链进槽，否则槽里那份根本起不来（实测过：
		// Cannot find package '@earendil-works/pi-coding-agent'）。
		// 软链而不是复制：两边本来就该用同一套已装依赖，复制既慢又容易走偏。
		const repoModules = join(repo, "node_modules");
		if (existsSync(repoModules)) {
			const link = join(target, "node_modules");
			rmSync(link, { recursive: true, force: true });
			symlinkSync(repoModules, link);
		}
		if (component === "gui") {
			const dist = join(repo, "gui", "frontend", "dist");
			if (existsSync(dist)) cpSync(dist, join(target, "gui", "frontend", "dist"), { recursive: true });
		}
		const spec = component === "gui" ? specOfSlot(target) : {};
		const manifest: SlotManifest = { ...plan.manifest, ...spec };
		writeFileSync(join(target, "manifest.json"), formatManifest(manifest), { mode: 0o600 });
		if (options.json) {
			console.log(JSON.stringify({ ok: true, component, slot: options.slot, target, manifest }, null, 2));
		} else {
			console.log(`已构建：${component} -> ${options.slot}`);
			console.log(`  来源：${options.ref}${sha ? ` (${sha})` : ""}${dirty ? "（脏工作区）" : ""}`);
			console.log(`  目录：${target}`);
			if (flattened.length > 0) console.log(`  已摊平入口：${flattened.join("、")}`);
		}
		return 0;
	} catch (error) {
		console.error(`ab-pack: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (process.argv[1] && process.argv[1].endsWith("ab-pack.ts")) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		console.error(`ab-pack: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
