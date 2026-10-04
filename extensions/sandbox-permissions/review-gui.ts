// review-gui.ts — 审核设置窗（windowName = review）的拉起与请求组装
//
// 为什么和 review-command 分开：那边是 TUI 面板与命令入口，这边只管「开窗」这一件事，
// 并且要能被单测（预检判定是纯函数，不真拉窗口）。
//
// 三个决定写在前面：
//   1 窗口是**长开**的设置窗，拉起来就不等它（launchGuiWindow，不是 runGuiWindow）。
//      等待式拉起会让 pi 的命令处理一直挂着，人改五分钟设置、会话就卡五分钟；
//      而且等不到结果还有超时杀窗——把正在改设置的窗口杀掉是最糟的行为。
//   2 「GUI 不可用」在拉窗之前就判：先 collectGuiDiagnosis 看启动器 / electron / 前端产物。
//      只靠 spawn 返回值不够——bin/gui 是个壳脚本，spawn 成功但 electron 缺失时
//      人只会看到一个什么都没有的桌面。判定结果直接当回退原因用（TUI 面板会照它给修法）。
//   3 请求里带上设置快照与维度元信息，窗口首屏不用等 IPC 就能画出来；
//      保存走另一条路（Electron 主进程 → scripts/review-settings-cli.ts → lib/review-settings.ts），
//      本文件不碰 TOML。

import { collectGuiDiagnosis, type GuiDiagnosis, type GuiFallbackReason } from "../../lib/gui-diagnosis.ts";
import { launchGuiWindow } from "../../lib/gui-runner.ts";
import {
	REVIEW_LIMITS,
	dimensionFieldSpecs,
	loadReviewSettings,
	resolveReviewSettingsPaths,
	type ReviewLimits,
	type ReviewSettings,
	type ReviewSettingsPaths,
} from "../../lib/review-settings.ts";
import { readKeyFromAuth } from "./classifier-key.ts";

/** 窗口名（与 gui/electron/init-data.js 的 WINDOW_CONFIGS 一致） */
export const REVIEW_WINDOW_NAME = "review";

/** 发给窗口的请求（字段与 init-data.js 的 buildInitData 一一对应） */
export interface ReviewWindowRequest {
	settings: ReviewSettings;
	specs: ReturnType<typeof dimensionFieldSpecs>;
	limits: ReviewLimits;
	paths: ReviewSettingsPaths;
	/** 分类模型 key 状态（只报有没有，不传值） */
	keyConfigured: boolean;
}

/**
 * 预检：这台机器现在能不能开出图形窗。
 * null = 可以；否则给出回退原因（直接喂给 gui-diagnosis 的修法生成）。
 */
export function reviewGuiUnavailableReason(d: GuiDiagnosis): GuiFallbackReason | null {
	if (!d.binary) return "no-binary";
	// 壳脚本在、但 electron 或前端产物缺：窗口起不来 / 白屏
	if (!d.hasElectron || !d.hasFrontendDist) return "spawn-failed";
	if (!d.hasDisplayEnv) return "spawn-failed";
	return null;
}

/** 组请求：设置从单一读入口取，维度元信息与取值范围一并带上（前端不再复制一份常量） */
export function buildReviewWindowRequest(): ReviewWindowRequest {
	return {
		settings: loadReviewSettings(),
		specs: dimensionFieldSpecs(),
		limits: REVIEW_LIMITS,
		paths: resolveReviewSettingsPaths(),
		keyConfigured: readKeyFromAuth() !== undefined,
	};
}

export interface OpenReviewGuiResult {
	opened: boolean;
	/** 没开成时的原因（喂给 announceGuiFallback） */
	reason?: GuiFallbackReason;
}

/**
 * 拉起审核设置窗。不阻塞、不等结果：窗口关掉就散，不需要回传什么。
 * checkCommands=false：预检只查文件与 PATH，不 fork systemctl（开窗不该被 hub 诊断拖住）。
 */
export function openReviewSettingsGui(
	deps: { diagnosis?: GuiDiagnosis; launch?: typeof launchGuiWindow; request?: ReviewWindowRequest } = {},
): OpenReviewGuiResult {
	const diagnosis = deps.diagnosis ?? collectGuiDiagnosis(false);
	const blocked = reviewGuiUnavailableReason(diagnosis);
	if (blocked) return { opened: false, reason: blocked };

	const request = deps.request ?? buildReviewWindowRequest();
	const result = (deps.launch ?? launchGuiWindow)(REVIEW_WINDOW_NAME, request);
	if (!result.ok) return { opened: false, reason: "spawn-failed" };
	return { opened: true };
}
