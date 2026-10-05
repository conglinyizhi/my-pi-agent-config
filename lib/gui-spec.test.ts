// lib/gui-spec.test.ts
// 跑法：node --test --experimental-strip-types lib/gui-spec.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compareSpecs, parseSpecOutput, specFromManifest, EXPECTED_PROTOCOL, REQUIRED_WINDOWS } from "./gui-spec.ts";

const GOOD = { protocol: EXPECTED_PROTOCOL, windows: ["gate", "review", "editor"], features: ["scriptEffects", "editCalls"] };

describe("解析 --spec 输出", () => {
	it("从夹杂的输出里挑出那行 JSON（从后往前找）", () => {
		const stdout = ["一些 Electron 噪音", JSON.stringify(GOOD), "尾部噪音"].join("\n");
		assert.deepEqual(parseSpecOutput(stdout), GOOD);
	});

	it("认不出就给 undefined，不猜", () => {
		assert.equal(parseSpecOutput(""), undefined);
		assert.equal(parseSpecOutput("{\"windows\":[\"gate\"]}"), undefined, "没有 protocol 不算 spec");
		assert.equal(parseSpecOutput("{坏 JSON"), undefined);
	});

	it("字段缺失当成空清单", () => {
		assert.deepEqual(parseSpecOutput(JSON.stringify({ protocol: 2 })), { protocol: 2, windows: [], features: [] });
	});
});

describe("比对能力", () => {
	it("都齐就兼容，且不啰嗦", () => {
		const verdict = compareSpecs(GOOD);
		assert.equal(verdict.compatible, true);
		assert.deepEqual(verdict.notices, []);
	});

	it("缺窗口时给出缺哪个，并说会退回 TUI", () => {
		const verdict = compareSpecs({ ...GOOD, windows: ["editor"] });
		assert.equal(verdict.compatible, false);
		assert.deepEqual(verdict.missingWindows, [...REQUIRED_WINDOWS]);
		assert.match(verdict.notices[0], /退回 TUI 面板/);
	});

	it("协议不一致只说一句，不算不兼容（只提示不拦）", () => {
		const verdict = compareSpecs({ ...GOOD, protocol: EXPECTED_PROTOCOL + 1 });
		assert.equal(verdict.compatible, true);
		assert.match(verdict.notices.join(""), /超前/);
		assert.match(verdict.notices.join(""), /只提示不拦/);
	});

	it("探测不到时措辞与「能力不足」分开", () => {
		const verdict = compareSpecs(undefined);
		assert.equal(verdict.unavailable, true);
		assert.match(verdict.notices[0], /问不到/);
	});

	it("按命令要的能力单查（比如设置窗只要 review）", () => {
		const verdict = compareSpecs({ ...GOOD, windows: ["gate"] }, { windows: ["review"], features: [] });
		assert.deepEqual(verdict.missingWindows, ["review"]);
	});
});

describe("从 manifest 读", () => {
	it("有 protocol 才认，窗口清单照抄", () => {
		assert.deepEqual(specFromManifest({ protocol: 1, windows: ["gate"] }), { protocol: 1, windows: ["gate"], features: [] });
		assert.equal(specFromManifest({ windows: ["gate"] }), undefined);
		assert.equal(specFromManifest(undefined), undefined);
	});
});

describe("bin/gui --spec 的端到端", () => {
	it("启动器直接吐一行可解析的 spec（不拉 Electron，所以无需图形环境）", () => {
		const repo = dirname(dirname(fileURLToPath(import.meta.url))); // lib/ 的上两级就是仓根
		const run = spawnSync(join(repo, "bin", "gui"), ["--spec"], { encoding: "utf8", timeout: 20_000 });
		assert.equal(run.status, 0, run.stderr);
		const spec = parseSpecOutput(run.stdout ?? "");
		assert.ok(spec, "输出里应该有一行可解析的 spec");
		assert.equal(spec?.protocol, EXPECTED_PROTOCOL);
		assert.ok(spec?.windows.includes("gate"));
		assert.deepEqual(compareSpecs(spec).notices, [], "这个 GUI 该是兼容的");
	});
});

