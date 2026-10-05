#!/usr/bin/env node
// scripts/ab-slot.ts — A/B 更新引擎的 CLI
//
//   ab-slot status [组件]                     四槽现状 + current 指向 + 计数 + 判定
//   ab-slot switch <组件> <槽>                原子换软链（槽 ∈ stable|previous|dev|head）
//   ab-slot rollback <组件> [--reason 说明]   current 指回 previous
//   ab-slot promote <组件> [--force]          dev 升为 stable（先看门槛，force 越过）
//   ab-slot note <组件> <clean|failure>       记一次干净往返 / 一次失败；达标按配置晋升或提示
//   ab-slot log <组件> [--tail N]             打印晋升与回退日志
//
// 通用参数：--runtime-root <dir>（默认 ~/.pi/runtime）、--threshold N、--no-auto-promote、--json
//
// 动盘逻辑全在 lib/ab-store.ts：CLI 与 pi 侧的观察层共用同一份，两套实现跑偏是这个项目头号风险。
// CLI 该报错就报错（人正看着终端）；pi 侧那层则永不抛异常（ab-watch.ts）。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	AB_COMPONENTS,
	AB_SLOTS,
	DEFAULT_THRESHOLD,
	type AbComponent,
	type AbSlot,
	type SlotManifest,
	isComponent,
	isSlot,
	slotPath,
} from "../lib/ab-slots.ts";
import {
	appendLog,
	assertRuntimeRoot,
	atomicLink,
	noteHealth,
	noteRoundTrip,
	nowIso,
	promote,
	readManifest,
	rollback,
	statusOf,
	tailLog,
} from "../lib/ab-store.ts";
import { canPromote } from "../lib/ab-pack.ts";

interface Options {
	runtimeRoot: string;
	threshold: number;
	autoPromote: boolean;
	json: boolean;
	force: boolean;
	reason?: string;
	tail: number;
	failThreshold?: number;
}

export function parseArgs(argv: string[]): { command: string; positional: string[]; options: Options } {
	const options: Options = {
		runtimeRoot: join(homedir(), ".pi", "runtime"),
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
		if (arg === "--fail-threshold") { options.failThreshold = Number(argv[++index] ?? 0) || undefined; continue; }
		positional.push(arg);
	}
	const [command = "", ...rest] = positional;
	return { command, positional: rest, options };
}

export function requireComponent(value: string | undefined): AbComponent {
	if (!isComponent(value)) throw new Error(`组件名必须是 ${AB_COMPONENTS.join(" | ")}，收到：${value ?? "(空)"}`);
	return value;
}

export function requireSlot(value: string | undefined): AbSlot {
	if (!isSlot(value)) throw new Error(`槽名必须是 ${AB_SLOTS.join(" | ")}，收到：${value ?? "(空)"}`);
	return value;
}

function print(value: unknown, json: boolean, text: string): void {
	if (json) console.log(JSON.stringify(value, null, 2));
	else console.log(text);
}

function reportStatus(runtimeRoot: string, components: AbComponent[], options: Options): number {
	const reports = components.map((component) =>
		statusOf(runtimeRoot, component, { threshold: options.threshold, autoPromote: options.autoPromote }),
	);
	if (options.json) {
		console.log(JSON.stringify({ runtimeRoot, reports }, null, 2));
		return 0;
	}
	console.log(`运行时根：${runtimeRoot}`);
	for (const report of reports) {
		console.log(`\n[${report.component}] current -> ${report.current ?? "(未设置)"}`);
		for (const slot of report.slots) {
			const manifest = slot.manifest as SlotManifest | undefined;
			const detail = manifest
				? `${manifest.ref ?? "?"}${manifest.dirty ? "（脏）" : ""} ${manifest.builtAt ?? ""}`
				: "(空)";
			console.log(`  ${slot.slot.padEnd(9)} ${slot.exists ? "有" : "无"}  ${detail}`);
		}
		console.log(`  计数：干净 ${report.streak.clean} / 阈值 ${options.threshold}，失败 ${report.streak.failures}`);
		console.log(`  判定：${report.decision.action}（${report.decision.reason}）`);
	}
	return 0;
}

export function runAbSlot(argv: string[]): number {
	const { command, positional, options } = parseArgs(argv);
	const runtimeRoot = assertRuntimeRoot(options.runtimeRoot);

	switch (command) {
		case "status": {
			const components = positional[0] ? [requireComponent(positional[0])] : [...AB_COMPONENTS];
			return reportStatus(runtimeRoot, components, options);
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
			rollback(runtimeRoot, component, options.reason);
			print({ ok: true, component, to: "previous" }, options.json, `已回退：${component} current -> previous`);
			return 0;
		}
		case "promote": {
			const component = requireComponent(positional[0]);
			// 脏产物不许晋升：它复现不出来，推上去之后"回退到这个版本"没有意义
			const allowed = canPromote(readManifest(runtimeRoot, component, "dev"), { force: options.force });
			if (!allowed.ok) {
				print({ ok: false, reason: allowed.reason }, options.json, `不晋升：${allowed.reason}`);
				return 0;
			}
			const status = statusOf(runtimeRoot, component, { threshold: options.threshold, autoPromote: options.autoPromote });
			if (status.decision.action !== "promote" && !options.force) {
				print(
					{ ok: false, action: status.decision.action, reason: status.decision.reason },
					options.json,
					`不晋升：${status.decision.reason}`,
				);
				return 0;
			}
			const note = options.force ? `手工强推（原判定：${status.decision.reason}）` : status.decision.reason;
			promote(runtimeRoot, component, note);
			print({ ok: true, component }, options.json, `已晋升：${component} dev -> stable，旧 stable 落到 previous`);
			return 0;
		}
		case "note": {
			const component = requireComponent(positional[0]);
			const outcome = positional[1];
			if (outcome !== "clean" && outcome !== "failure") throw new Error("note 的第二个参数必须是 clean 或 failure");
			const result = noteRoundTrip({
				runtimeRoot,
				component,
				outcome,
				...(options.reason ? { reason: options.reason } : {}),
				threshold: options.threshold,
				autoPromote: options.autoPromote,
			});
			if (result.promoted) {
				print(
					{ ok: true, promoted: true, clean: result.clean },
					options.json,
					`干净 ${result.clean} 次，已达阈值：已自动晋升 ${component}`,
				);
				return 0;
			}
			if (result.action === "notify") {
				print({ ok: true, promoted: false, action: "notify" }, options.json, `干净 ${result.clean} 次，${result.reason}`);
				return 0;
			}
			print(
				{ ok: true, promoted: false, clean: result.clean },
				options.json,
				`已记录（${outcome}）：干净 ${result.clean}/${result.threshold}`,
			);
			return 0;
		}
		case "health": {
			const component = requireComponent(positional[0]);
			const verdict = positional[1];
			if (verdict !== "ok" && verdict !== "fail") throw new Error("health 的第二个参数必须是 ok 或 fail");
			const result = noteHealth({
				runtimeRoot,
				component,
				ok: verdict === "ok",
				...(options.reason ? { reason: options.reason } : {}),
				...(options.failThreshold !== undefined ? { failThreshold: options.failThreshold } : {}),
			});
			const tail = result.rolledBack ? "，已达看门狗门槛：已自动回退到上一版" : `（连续失败 ${result.failing}）`;
			print(
				{ ok: true, health: result.ok, failing: result.failing, rolledBack: result.rolledBack },
				options.json,
				`已记录自检（${verdict}）${tail}`,
			);
			return 0;
		}
		case "log": {
			const component = requireComponent(positional[0]);
			const lines = tailLog(runtimeRoot, component, options.tail);
			print({ ok: true, lines }, options.json, lines.length > 0 ? lines.join("\n") : "(还没有日志)");
			return 0;
		}
		default:
			console.error("用法：ab-slot <status|switch|rollback|promote|note|log> …（参数说明见脚本头部注释）");
			return 2;
	}
}

if (process.argv[1] && process.argv[1].endsWith("ab-slot.ts")) {
	try {
		process.exit(runAbSlot(process.argv.slice(2)));
	} catch (error) {
		console.error(`ab-slot: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
