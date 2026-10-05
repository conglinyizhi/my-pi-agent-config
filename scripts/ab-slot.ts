#!/usr/bin/env node
// scripts/ab-slot.ts — A/B 更新引擎的 CLI（期 1：槽位与切换）
//
//   ab-slot status [组件]                     四槽现状 + current 指向 + 计数 + 最近日志
//   ab-slot switch <组件> <槽>                原子换软链（槽 ∈ stable|previous|dev|head）
//   ab-slot rollback <组件> [--reason 说明]   current 指回 previous
//   ab-slot promote <组件> [--force]          dev 升为 stable（先看门槛，force 越过）
//   ab-slot note <组件> <clean|failure>       记一次干净往返 / 一次失败；达标按配置晋升或提示
//   ab-slot log <组件> [--tail N]             打印晋升与回退日志
//
// 通用参数：--runtime-root <dir>（默认 ~/.pi/runtime）、--threshold N、--no-auto-promote、--json
//
// 设计约束（见 docs/plans/2026-10-05-ab-update.md）：
//   - 换软链是原子的：先写 current.tmp 再 rename 覆盖
//   - 晋升顺序不能反：先把旧 stable 挪到 previous，再让 dev 顶上去
//   - 删除动作的目标全部来自槽名白名单 + 运行时根，不接受任意路径

import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	AB_COMPONENTS,
	AB_SLOTS,
	DEFAULT_THRESHOLD,
	componentPath,
	currentLink,
	decidePromotion,
	emptyStreak,
	formatManifest,
	formatStreak,
	isComponent,
	isSlot,
	parseManifest,
	parseStreak,
	planPromotion,
	planRollback,
	promoteLogPath,
	slotPath,
	slotToken,
	streakAfter,
	streakPath,
	type AbComponent,
	type AbSlot,
	type SlotManifest,
} from "../lib/ab-slots.ts";

interface Options {
	runtimeRoot: string;
	threshold: number;
	autoPromote: boolean;
	json: boolean;
	force: boolean;
	reason?: string;
	tail: number;
}

function runtimeRootDefault(): string {
	return join(homedir(), ".pi", "runtime");
}

/** 运行时根不许是 / 或空：下面有删除动作，目标必须是收窄过的目录 */
function assertRuntimeRoot(root: string): string {
	const resolved = resolve(root);
	if (resolved === "/" || basename(resolved) === "") {
		throw new Error(`运行时根不合法：${root}`);
	}
	return resolved;
}

function parseArgs(argv: string[]): { command: string; positional: string[]; options: Options } {
	const options: Options = {
		runtimeRoot: runtimeRootDefault(),
		threshold: DEFAULT_THRESHOLD,
		autoPromote: true,
		json: false,
		force: false,
		tail: 20,
	};
	const positional: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--runtime-root") { options.runtimeRoot = argv[++index] ?? options.runtimeRoot; continue; }
		if (arg === "--threshold") { options.threshold = Number(argv[++index] ?? options.threshold); continue; }
		if (arg === "--no-auto-promote") { options.autoPromote = false; continue; }
		if (arg === "--json") { options.json = true; continue; }
		if (arg === "--force") { options.force = true; continue; }
		if (arg === "--reason") { options.reason = argv[++index]; continue; }
		if (arg === "--tail") { options.tail = Number(argv[++index] ?? options.tail); continue; }
		positional.push(arg);
	}
	const [command = "", ...rest] = positional;
	return { command, positional: rest, options };
}

function requireComponent(value: string | undefined): AbComponent {
	if (!isComponent(value)) throw new Error(`组件名必须是 ${AB_COMPONENTS.join(" | ")}，收到：${value ?? "(空)"}`);
	return value;
}

function requireSlot(value: string | undefined): AbSlot {
	if (!isSlot(value)) throw new Error(`槽名必须是 ${AB_SLOTS.join(" | ")}，收到：${value ?? "(空)"}`);
	return value;
}

/** 原子换软链：先写临时名再 rename 覆盖，任何时刻 current 都指向一个完整目标 */
function atomicLink(runtimeRoot: string, component: AbComponent, slot: AbSlot): void {
	const componentDir = componentPath(runtimeRoot, component);
	mkdirSync(componentDir, { recursive: true });
	const tmp = `${currentLink(runtimeRoot, component)}.tmp-${process.pid}`;
	rmSync(tmp, { force: true });
	symlinkSync(slotPath(runtimeRoot, component, slot), tmp);
	renameSync(tmp, currentLink(runtimeRoot, component));
}

function moveSlot(runtimeRoot: string, component: AbComponent, from: AbSlot, to: AbSlot): void {
	const source = slotPath(runtimeRoot, component, from);
	const target = slotPath(runtimeRoot, component, to);
	rmSync(target, { recursive: true, force: true });
	if (existsSync(source)) renameSync(source, target);
}

function appendLog(runtimeRoot: string, component: AbComponent, line: string, at: string): void {
	const path = promoteLogPath(runtimeRoot, component);
	mkdirSync(componentPath(runtimeRoot, component), { recursive: true });
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	writeFileSync(path, `${existing}${at} ${line}\n`, "utf8");
}

function readManifest(runtimeRoot: string, component: AbComponent, slot: AbSlot): SlotManifest | undefined {
	const path = join(slotPath(runtimeRoot, component, slot), "manifest.json");
	if (!existsSync(path)) return undefined;
	return parseManifest(readFileSync(path, "utf8"));
}

function readStreak(runtimeRoot: string, component: AbComponent) {
	const path = streakPath(runtimeRoot, component);
	return existsSync(path) ? parseStreak(readFileSync(path, "utf8")) : emptyStreak();
}

function writeStreak(runtimeRoot: string, component: AbComponent, state: ReturnType<typeof emptyStreak>): void {
	mkdirSync(componentPath(runtimeRoot, component), { recursive: true });
	writeFileSync(streakPath(runtimeRoot, component), formatStreak(state), "utf8");
}

function currentSlot(runtimeRoot: string, component: AbComponent): AbSlot | undefined {
	const link = currentLink(runtimeRoot, component);
	if (!existsSync(link)) return undefined;
	try {
		const target = readlinkSync(link);
		const name = basename(target);
		return isSlot(name) ? name : undefined;
	} catch {
		return undefined;
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

function doPromote(runtimeRoot: string, component: AbComponent, note: string): void {
	for (const action of planPromotion({ current: currentSlot(runtimeRoot, component), at: nowIso(), note })) {
		if (action.kind === "move" && action.from && action.to) moveSlot(runtimeRoot, component, action.from, action.to);
		if (action.kind === "link" && action.to) atomicLink(runtimeRoot, component, action.to);
		if (action.kind === "log" && action.text) appendLog(runtimeRoot, component, action.text, nowIso());
	}
	writeStreak(runtimeRoot, component, emptyStreak("dev"));
}

function doRollback(runtimeRoot: string, component: AbComponent, reason: string | undefined): void {
	for (const action of planRollback({ at: nowIso(), ...(reason ? { reason } : {}) })) {
		if (action.kind === "link" && action.to) atomicLink(runtimeRoot, component, action.to);
		if (action.kind === "log" && action.text) appendLog(runtimeRoot, component, action.text, nowIso());
	}
}

function statusOf(runtimeRoot: string, component: AbComponent) {
	const slots = AB_SLOTS.map((slot) => {
		const dir = slotPath(runtimeRoot, component, slot);
		const manifest = readManifest(runtimeRoot, component, slot);
		return {
			slot,
			path: dir,
			exists: existsSync(dir),
			...(manifest ? { manifest } : {}),
			...(manifest ? { token: slotToken(manifest) } : {}),
		};
	});
	const streak = readStreak(runtimeRoot, component);
	const decision = decidePromotion(streak, { threshold: thresholdRef, autoPromote: autoPromoteRef });
	return { component, current: currentSlot(runtimeRoot, component), slots, streak, decision };
}

// 状态输出要用到这两个值；用模块级变量而不是全局散布（只被 main 设一次）
let thresholdRef = DEFAULT_THRESHOLD;
let autoPromoteRef = true;

function print(value: unknown, json: boolean, text: string): void {
	if (json) console.log(JSON.stringify(value, null, 2));
	else console.log(text);
}

function main(argv: string[]): number {
	const { command, positional, options } = parseArgs(argv);
	const runtimeRoot = assertRuntimeRoot(options.runtimeRoot);
	thresholdRef = options.threshold;
	autoPromoteRef = options.autoPromote;

	switch (command) {
		case "status": {
			const components = positional[0] ? [requireComponent(positional[0])] : [...AB_COMPONENTS];
			const reports = components.map((component) => statusOf(runtimeRoot, component));
			if (options.json) {
				console.log(JSON.stringify({ runtimeRoot, reports }, null, 2));
				return 0;
			}
			console.log(`运行时根：${runtimeRoot}`);
			for (const report of reports) {
				console.log(`\n[${report.component}] current -> ${report.current ?? "(未设置)"}`);
				for (const slot of report.slots) {
					const manifest = slot.manifest as SlotManifest | undefined;
					const detail = manifest ? `${manifest.ref ?? "?"}${manifest.dirty ? "（脏）" : ""} ${manifest.builtAt ?? ""}` : "(空)";
					console.log(`  ${slot.slot.padEnd(9)} ${slot.exists ? "有" : "无"}  ${detail}`);
				}
				console.log(`  计数：干净 ${report.streak.clean} / 阈值 ${options.threshold}，失败 ${report.streak.failures}`);
				console.log(`  判定：${report.decision.action}（${report.decision.reason}）`);
			}
			return 0;
		}
		case "switch": {
			const component = requireComponent(positional[0]);
			const slot = requireSlot(positional[1]);
			atomicLink(runtimeRoot, component, slot);
			appendLog(runtimeRoot, component, JSON.stringify({ event: "switch", to: slot }), nowIso());
			print({ ok: true, component, slot }, options.json, `已切换：${component} current -> ${slot}`);
			return 0;
		}
		case "rollback": {
			const component = requireComponent(positional[0]);
			if (!existsSync(slotPath(runtimeRoot, component, "previous"))) {
				throw new Error(`没有 previous 槽，退不了：${slotPath(runtimeRoot, component, "previous")}`);
			}
			doRollback(runtimeRoot, component, options.reason);
			print({ ok: true, component, to: "previous" }, options.json, `已回退：${component} current -> previous`);
			return 0;
		}
		case "promote": {
			const component = requireComponent(positional[0]);
			const streak = readStreak(runtimeRoot, component);
			const decision = decidePromotion(streak, { threshold: options.threshold, autoPromote: options.autoPromote });
			if (decision.action !== "promote" && !options.force) {
				print({ ok: false, action: decision.action, reason: decision.reason }, options.json, `不晋升：${decision.reason}`);
				return 0;
			}
			doPromote(runtimeRoot, component, options.force ? `手工强推（原判定：${decision.reason}）` : decision.reason);
			print({ ok: true, component }, options.json, `已晋升：${component} dev -> stable，旧 stable 落到 previous`);
			return 0;
		}
		case "note": {
			const component = requireComponent(positional[0]);
			const outcome = positional[1];
			if (outcome !== "clean" && outcome !== "failure") throw new Error("note 的第二个参数必须是 clean 或 failure");
			const next = streakAfter(readStreak(runtimeRoot, component), outcome, {
				now: nowIso(),
				...(options.reason ? { reason: options.reason } : {}),
			});
			writeStreak(runtimeRoot, component, next);
			appendLog(runtimeRoot, component, JSON.stringify({ event: "note", outcome, clean: next.clean, ...(options.reason ? { reason: options.reason } : {}) }), nowIso());
			const decision = decidePromotion(next, { threshold: options.threshold, autoPromote: options.autoPromote });
			if (decision.action === "promote") {
				doPromote(runtimeRoot, component, decision.reason);
				print({ ok: true, promoted: true, clean: next.clean }, options.json, `干净 ${next.clean} 次，已达阈值：已自动晋升 ${component}`);
				return 0;
			}
			if (decision.action === "notify") {
				appendLog(runtimeRoot, component, JSON.stringify({ event: "promote-notice" }), nowIso());
				print({ ok: true, promoted: false, action: "notify" }, options.json, `干净 ${next.clean} 次，${decision.reason}`);
				return 0;
			}
			print({ ok: true, promoted: false, clean: next.clean }, options.json, `已记录（${outcome}）：干净 ${next.clean}/${options.threshold}`);
			return 0;
		}
		case "log": {
			const component = requireComponent(positional[0]);
			const path = promoteLogPath(runtimeRoot, component);
			if (!existsSync(path)) {
				print({ ok: true, lines: [] }, options.json, "(还没有日志)");
				return 0;
			}
			const lines = readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
			const tail = lines.slice(Math.max(0, lines.length - options.tail));
			print({ ok: true, lines: tail }, options.json, tail.join("\n"));
			return 0;
		}
		default:
			console.error("用法：ab-slot <status|switch|rollback|promote|note|log> …（--help 见脚本头部注释）");
			return 2;
	}
}

try {
	process.exit(main(process.argv.slice(2)));
} catch (error) {
	console.error(`ab-slot: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
