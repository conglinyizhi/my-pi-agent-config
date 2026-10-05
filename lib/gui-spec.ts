// lib/gui-spec.ts — GUI 的能力探测（不比对版本号）
//
// 为什么需要：提督会周期性地压缩 + reload 重启核心，于是「磁盘上的 GUI」与「正在跑的 pi」
// 常常不是同一代。版本号比对会立刻变成一个单点，所以改成问它能干什么，缺什么就降级。
//
// 探测方式：bin/gui.sh --spec 由启动器直接问 init-data.js（node 起一下，不拉 Electron），
// 既快又不碰 Electron 的启动路径（就绪前退出会崩，2026-10-05 踩过一次）。
//
// 两个来源，按代价分：
//   1. 槽里的 manifest（便宜，不 spawn）：会话启动时的提示用这个
//   2. bin/gui.sh --spec 真探测（便宜，不拉 Electron）：真要决定降级时才用，进程内缓存

import { spawnSync } from "node:child_process";
import { findGuiBinary } from "./gui-runner.ts";

/** 这个 pi 侧构建期望的协议版本：破坏性字段变更才 +1 */
export const EXPECTED_PROTOCOL = 1;

/** 闸门这条链离不开的能力 */
export const REQUIRED_WINDOWS: readonly string[] = ["gate"];
export const REQUIRED_FEATURES: readonly string[] = ["scriptEffects"];

export interface GuiSpec {
	protocol: number;
	windows: string[];
	features: string[];
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** 从 --spec 的输出里找最后一行能解析成 spec 的 JSON（Electron 会夹带别的输出） */
export function parseSpecOutput(stdout: string): GuiSpec | undefined {
	const lines = String(stdout ?? "").split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index].trim();
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as Partial<GuiSpec>;
			if (typeof parsed.protocol !== "number") continue;
			return {
				protocol: parsed.protocol,
				windows: asStringArray(parsed.windows),
				features: asStringArray(parsed.features),
			};
		} catch {
			// 不是 spec 行，继续往上找
		}
	}
	return undefined;
}

export interface SpecVerdict {
	/** 闸门链要的东西都在 */
	compatible: boolean;
	/** 给人看的一句话；没问题时为空 */
	notices: string[];
	/** 探测不到 GUI 时置位：命令该退回 TUI 面板 */
	unavailable: boolean;
	missingWindows: string[];
	missingFeatures: string[];
}

/**
	* 比对这个 GUI 能干什么。只给结论与提示，不做拦截。
	*
	* spec 为 undefined 表示探测不到（没图形环境、二进制不在、起不来）：
	* 那种情况不算「能力不足」，而是「问不到」，提示措辞要分开。
	*/
export function compareSpecs(
	spec: GuiSpec | undefined,
	expectation: { windows?: readonly string[]; features?: readonly string[]; protocol?: number } = {},
): SpecVerdict {
	const wantWindows = expectation.windows ?? REQUIRED_WINDOWS;
	const wantFeatures = expectation.features ?? REQUIRED_FEATURES;
	const wantProtocol = expectation.protocol ?? EXPECTED_PROTOCOL;
	if (!spec) {
		return {
			compatible: false,
			notices: ["问不到 GUI 的能力（没图形环境或起不来），相关命令会退回 TUI 面板"],
			unavailable: true,
			missingWindows: [...wantWindows],
			missingFeatures: [...wantFeatures],
		};
	}
	const missingWindows = wantWindows.filter((name) => !spec.windows.includes(name));
	const missingFeatures = wantFeatures.filter((name) => !spec.features.includes(name));
	const notices: string[] = [];
	if (missingWindows.length > 0) {
		notices.push(`当前 GUI 不支持这些窗口：${missingWindows.join("、")}（相关命令会退回 TUI 面板）`);
	}
	if (missingFeatures.length > 0) {
		notices.push(`当前 GUI 不认这些字段：${missingFeatures.join("、")}（会按降级渲染）`);
	}
	if (spec.protocol !== wantProtocol) {
		const direction = spec.protocol > wantProtocol ? "超前" : "落后";
		notices.push(`GUI 协议${direction}（GUI ${spec.protocol} / pi ${wantProtocol}），只提示不拦`);
	}
	return {
		compatible: missingWindows.length === 0 && missingFeatures.length === 0,
		notices,
		unavailable: false,
		missingWindows,
		missingFeatures,
	};
}

/** 从槽 manifest 里读协议信息（不 spawn，会话启动时用这个） */
export function specFromManifest(manifest: { protocol?: number; windows?: string[] } | undefined): GuiSpec | undefined {
	if (!manifest || typeof manifest.protocol !== "number") return undefined;
	return { protocol: manifest.protocol, windows: asStringArray(manifest.windows), features: [] };
}

let cachedProbe: { ok: boolean; spec?: GuiSpec; reason?: string } | undefined;

/** 真探测一次 gui --spec（进程内缓存；起不来就如实说问不到） */
export function readGuiSpec(options: { bin?: string | null; timeoutMs?: number } = {}): {
	ok: boolean;
	spec?: GuiSpec;
	reason?: string;
} {
	if (cachedProbe && options.bin === undefined) return cachedProbe;
	const bin = options.bin === undefined ? findGuiBinary() : options.bin;
	if (!bin) {
		const result = { ok: false, reason: "找不到 GUI 启动器" };
		if (options.bin === undefined) cachedProbe = result;
		return result;
	}
	try {
		const run = spawnSync(bin, ["--spec"], { encoding: "utf8", timeout: options.timeoutMs ?? 5000 });
		const spec = parseSpecOutput(run.stdout ?? "");
		const result = spec
			? { ok: true, spec }
			: { ok: false, reason: `探测失败（退出码 ${run.status ?? "?"}）` };
		if (options.bin === undefined) cachedProbe = result;
		return result;
	} catch (error) {
		const result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
		if (options.bin === undefined) cachedProbe = result;
		return result;
	}
}
