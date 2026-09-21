// lib/gui-diagnosis.test.ts — 回退原因诊断与提示文本
// 跑法：node --experimental-strip-types lib/gui-diagnosis.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	announceGuiFallback,
	classifyGuiFailure,
	collectGuiDiagnosis,
	displayPath,
	formatGuiFallbackNotice,
	guiBinaryCandidates,
	guiFallbackFixSteps,
	guiFallbackReasonText,
	guiFallbackTitleHint,
	resetGuiFallbackNotices,
	type GuiDiagnosis,
	type GuiFallbackReason,
} from "./gui-diagnosis.ts";

function diag(overrides: Partial<GuiDiagnosis> = {}): GuiDiagnosis {
	return {
		binary: null,
		candidates: guiBinaryCandidates().map((p) => ({ path: p, exists: false, executable: false })),
		repoRoot: "/repo",
		hasHubSocket: true,
		hubUnitActive: true,
		hasWailsCli: true,
		hasGo: true,
		hasFrontendDist: true,
		hasWebkit2Gtk41: true,
		hasDisplayEnv: true,
		...overrides,
	};
}

describe("classifyGuiFailure", () => {
	it("runGuiWindow 的 reason 映射到诊断原因", () => {
		assert.equal(classifyGuiFailure("unavailable"), "no-binary");
		assert.equal(classifyGuiFailure("spawn"), "spawn-failed");
		assert.equal(classifyGuiFailure("timeout"), "timeout");
		assert.equal(classifyGuiFailure("exited"), "exited");
		// 未知/缺失按「没二进制」处理，不静默成空
		assert.equal(classifyGuiFailure(undefined), "no-binary");
	});
});

describe("collectGuiDiagnosis", () => {
	it("跳过子进程检查时仍给出候选位与 socket 状态", () => {
		const d = collectGuiDiagnosis(false);
		assert.equal(d.candidates.length, guiBinaryCandidates().length);
		assert.equal(d.hubUnitActive, null);
		assert.equal(typeof d.hasHubSocket, "boolean");
		assert.equal(typeof d.hasDisplayEnv, "boolean");
	});
});

describe("guiFallbackReasonText", () => {
	it("每种原因都有非空文案", () => {
		const reasons: GuiFallbackReason[] = [
			"no-binary",
			"spawn-failed",
			"timeout",
			"exited",
			"hub-unreachable",
			"hub-no-channel",
		];
		for (const r of reasons) {
			assert.ok(guiFallbackReasonText(r, diag()).length > 0, r);
		}
	});
});

describe("guiFallbackFixSteps", () => {
	it("没有二进制时给 wails build，并按需补装 CLI", () => {
		const steps = guiFallbackFixSteps("no-binary", diag({ hasWailsCli: false }));
		const text = steps.join("\n");
		assert.match(text, /wails build -tags webkit2_41/);
		assert.match(text, /go install github\.com\/wailsapp\/wails/);
	});

	it("候选位有文件但不可执行时先 chmod，不去劝重构建", () => {
		const stuck = { path: "/repo/wails-gui/build/bin/wails-gui", exists: true, executable: false };
		const steps = guiFallbackFixSteps("no-binary", diag({ candidates: [stuck], binary: null }));
		assert.match(steps.join("\n"), /chmod \+x \/repo\/wails-gui\/build\/bin\/wails-gui/);
		assert.doesNotMatch(steps.join("\n"), /wails build/);
	});

	it("缺 WebKitGTK 时点名依赖", () => {
		const steps = guiFallbackFixSteps("spawn-failed", diag({ binary: "/bin/wails-gui", hasWebkit2Gtk41: false }));
		assert.match(steps.join("\n"), /webkit2gtk-4\.1/);
	});

	it("hub 连不上时给 install.sh", () => {
		const steps = guiFallbackFixSteps("hub-unreachable", diag({ hasHubSocket: false, hubUnitActive: false }));
		assert.match(steps.join("\n"), /hub\/install\.sh/);
	});

	it("hub-no-channel 不反过来劝人装 hub", () => {
		const steps = guiFallbackFixSteps("hub-no-channel", diag({ binary: "/bin/wails-gui" }));
		const text = steps.join("\n");
		assert.doesNotMatch(text, /hub\/install\.sh/);
		assert.match(text, /lark-cli/);
	});

	it("timeout 且没有显示变量时点出会话问题", () => {
		const steps = guiFallbackFixSteps("timeout", diag({ binary: "/bin/wails-gui", hasDisplayEnv: false }));
		assert.match(steps.join("\n"), /DISPLAY/);
	});

	it("末尾始终给排查文档路径", () => {
		const steps = guiFallbackFixSteps("exited", diag({ binary: "/bin/wails-gui" }));
		assert.match(steps.at(-1) ?? "", /gui-fallback-recovery\.md$/);
	});
});

describe("提示文本", () => {
	it("标题提示是一行且带原因", () => {
		const hint = guiFallbackTitleHint("no-binary", diag());
		assert.equal(hint.includes("\n"), false);
		assert.match(hint, /没找到 wails-gui/);
	});

	it("notify 文本首行是原因，后续是编号步骤", () => {
		const notice = formatGuiFallbackNotice("no-binary", diag());
		const lines = notice.split("\n");
		assert.match(lines[1], /^1\. /);
	});
});

describe("announceGuiFallback", () => {
	it("同一原因只提示一次，reset 后可再提示", () => {
		resetGuiFallbackNotices();
		const seen: string[] = [];
		const ctx = { ui: { notify: (m: string) => void seen.push(m) } };
		const d = diag();

		assert.notEqual(announceGuiFallback(ctx, "no-binary", { diagnosis: d }), "");
		assert.equal(announceGuiFallback(ctx, "no-binary", { diagnosis: d }), "");
		assert.equal(seen.length, 1);

		// 不同原因各提示一次
		assert.notEqual(announceGuiFallback(ctx, "hub-unreachable", { diagnosis: d }), "");
		assert.equal(seen.length, 2);

		resetGuiFallbackNotices();
		assert.notEqual(announceGuiFallback(ctx, "no-binary", { diagnosis: d }), "");
		assert.equal(seen.length, 3);
		resetGuiFallbackNotices();
	});

	it("force 跳过去重", () => {
		resetGuiFallbackNotices();
		const seen: string[] = [];
		const ctx = { ui: { notify: (m: string) => void seen.push(m) } };
		announceGuiFallback(ctx, "no-binary", { diagnosis: diag() });
		announceGuiFallback(ctx, "no-binary", { diagnosis: diag(), force: true });
		assert.equal(seen.length, 2);
		resetGuiFallbackNotices();
	});

	it("没有 ui 也不抛", () => {
		resetGuiFallbackNotices();
		assert.doesNotThrow(() => announceGuiFallback(undefined, "no-binary", { diagnosis: diag() }));
		resetGuiFallbackNotices();
	});
});

describe("displayPath", () => {
	it("家目录前缀收成 ~", () => {
		const p = `${process.env.HOME}/.pi/agent/x.md`;
		assert.ok(displayPath(p).startsWith("~/"), displayPath(p));
		assert.equal(displayPath("/etc/hosts"), "/etc/hosts");
	});
});
