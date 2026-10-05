// flows-gui.ts — 审核流程窗（windowName = flows）的拉起
//
// 与审核设置窗同一套：先做开窗前置判定，再拉起；不阻塞、不等结果（窗口关掉就散）。
// 数据不预先塞进请求里：图与源码在窗口打开后现取（走 flows-cli 那条桥）。

import { collectGuiDiagnosis, guiWindowUnavailableReason, type GuiDiagnosis, type GuiFallbackReason } from "../../lib/gui-diagnosis.ts";
import { launchGuiWindow } from "../../lib/gui-runner.ts";

/** 窗口名（与 gui/electron/init-data.js 的 WINDOW_CONFIGS 一致） */
export const FLOWS_WINDOW_NAME = "flows";

export interface OpenFlowsGuiResult {
	opened: boolean;
	reason?: GuiFallbackReason;
}

export function openFlowsGui(
	deps: { diagnosis?: GuiDiagnosis; launch?: typeof launchGuiWindow } = {},
): OpenFlowsGuiResult {
	const diagnosis = deps.diagnosis ?? collectGuiDiagnosis(false);
	const blocked = guiWindowUnavailableReason(diagnosis);
	if (blocked) return { opened: false, reason: blocked };
	const result = (deps.launch ?? launchGuiWindow)(FLOWS_WINDOW_NAME, {});
	if (!result.ok) return { opened: false, reason: "spawn-failed" };
	return { opened: true };
}
