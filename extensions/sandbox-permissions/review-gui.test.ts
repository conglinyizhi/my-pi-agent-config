// review-gui.test.ts — 审核设置窗的预检与请求组装（不真拉窗口）
//
// 跑法：node --test --experimental-strip-types extensions/sandbox-permissions/review-gui.test.ts
//
// 这里不启动 electron：launch 与 diagnosis 都是注入的。盯的是「什么时候该回退 TUI」——
// 预检漏一项，用户就会看到一个空窗口或者什么都没有，而不是拿到 TUI 面板与修法。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GuiDiagnosis } from "../../lib/gui-diagnosis.ts";
import { REVIEW_WINDOW_NAME, buildReviewWindowRequest, openReviewSettingsGui, reviewGuiUnavailableReason } from "./review-gui.ts";

function diagnosis(overrides: Partial<GuiDiagnosis> = {}): GuiDiagnosis {
	const ok: GuiDiagnosis = {
		binary: "/home/u/.pi/agent/bin/gui",
		candidates: [],
		repoRoot: "/home/u/.pi/agent",
		hasHubSocket: true,
		hubUnitActive: true,
		hasElectron: true,
		hasFrontendDist: true,
		hasDisplayEnv: true,
	};
	return { ...ok, ...overrides };
}

describe("reviewGuiUnavailableReason", () => {
	it("齐备时放行（null）", () => {
		assert.equal(reviewGuiUnavailableReason(diagnosis()), null);
	});

	it("没有启动器 / electron / 前端产物 都算不可用", () => {
		assert.equal(reviewGuiUnavailableReason(diagnosis({ binary: null })), "no-binary");
		assert.equal(reviewGuiUnavailableReason(diagnosis({ hasElectron: false })), "spawn-failed");
		assert.equal(reviewGuiUnavailableReason(diagnosis({ hasFrontendDist: false })), "spawn-failed");
	});

	it("没有 DISPLAY / WAYLAND_DISPLAY 也不开窗（开了也显示不出来）", () => {
		assert.equal(reviewGuiUnavailableReason(diagnosis({ hasDisplayEnv: false })), "spawn-failed");
	});
});

describe("openReviewSettingsGui", () => {
	it("不可用时不开窗，把原因原样交回去（调用方据此回退 TUI）", () => {
		let launched = 0;
		const result = openReviewSettingsGui({
			diagnosis: diagnosis({ binary: null }),
			launch: () => {
				launched += 1;
				return { ok: true };
			},
		});
		assert.deepEqual(result, { opened: false, reason: "no-binary" });
		assert.equal(launched, 0, "预检不过就不该 spawn");
	});

	it("可用时用 review 窗口名拉起，请求里带设置 / 维度元信息 / 范围 / 路径", () => {
		const seen: { name: string; request: unknown }[] = [];
		const result = openReviewSettingsGui({
			diagnosis: diagnosis(),
			request: buildReviewWindowRequest(),
			launch: (name, request) => {
				seen.push({ name, request });
				return { ok: true };
			},
		});
		assert.deepEqual(result, { opened: true });
		assert.equal(seen.length, 1);
		assert.equal(seen[0].name, REVIEW_WINDOW_NAME);
		assert.equal(seen[0].name, "review");
	});

	it("spawn 失败按 spawn-failed 回报，不抛", () => {
		const result = openReviewSettingsGui({
			diagnosis: diagnosis(),
			request: buildReviewWindowRequest(),
			launch: () => ({ ok: false, reason: "spawn" }),
		});
		assert.deepEqual(result, { opened: false, reason: "spawn-failed" });
	});
});

describe("buildReviewWindowRequest", () => {
	it("读真实配置（只读）并带上窗口首屏需要的全部东西", () => {
		const request = buildReviewWindowRequest();
		assert.equal(request.settings.llm.mode === "auto" || request.settings.llm.mode === "strict", true);
		assert.equal(request.settings.dimensions.length, 8);
		assert.equal(request.specs.length, 8);
		assert.equal(request.limits.step, 0.05);
		assert.ok(request.paths.extensionsToml.endsWith("extensions.toml"));
		assert.ok(request.paths.dimensionsToml.endsWith("review-dimensions.toml"));
		assert.equal(typeof request.keyConfigured, "boolean");
		// 只报 key 状态，绝不把 key 值带进请求
		assert.equal(JSON.stringify(request).includes("apiKey"), false);
	});
});
