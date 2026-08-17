// status-bus.test.ts — 状态栏总线：包装/记录/转发/幂等/快照/重置
// 跑法：node --experimental-strip-types lib/status-bus.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StatusBus, type StatusUI } from "./status-bus.ts";

/** 构造一个可观测的假 ui：记录每次原生调用（= TUI 目标） */
function makeUI(): { ui: StatusUI; calls: Array<{ method: string; args: unknown[] }> } {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const ui: StatusUI = {
		setStatus(key, text) {
			calls.push({ method: "setStatus", args: [key, text] });
		},
		setWidget(key, content, options) {
			calls.push({ method: "setWidget", args: [key, content, options] });
		},
		setWorkingMessage(message) {
			calls.push({ method: "setWorkingMessage", args: [message] });
		},
		setWorkingVisible(visible) {
			calls.push({ method: "setWorkingVisible", args: [visible] });
		},
		setWorkingIndicator(options) {
			calls.push({ method: "setWorkingIndicator", args: [options] });
		},
	};
	return { ui, calls };
}

describe("StatusBus.attach（幂等包装）", () => {
	it("首次 attach 返回 true，重复 attach 返回 false", () => {
		const bus = new StatusBus();
		const { ui } = makeUI();
		assert.equal(bus.attach(ui), true);
		assert.equal(bus.attach(ui), false);
	});
});

describe("setStatus 记录 + 转发", () => {
	it("写入记录进快照并转发原生", () => {
		const bus = new StatusBus();
		const { ui, calls } = makeUI();
		bus.attach(ui);

		ui.setStatus("sandbox-guard", "🔒 19 条黑名单");

		assert.equal(bus.getSnapshot().statuses["sandbox-guard"].text, "🔒 19 条黑名单");
		assert.deepEqual(calls, [{ method: "setStatus", args: ["sandbox-guard", "🔒 19 条黑名单"] }]);
	});

	it("store 存去 ANSI 的纯文本，转发仍保留原始着色（数据/渲染分离）", () => {
		const bus = new StatusBus();
		const { ui, calls } = makeUI();
		bus.attach(ui);

		const colored = "\x1b[36m林汐\x1b[0m";
		ui.setStatus("trident", colored);

		assert.equal(bus.getSnapshot().statuses["trident"].text, "林汐");
		assert.deepEqual(calls, [{ method: "setStatus", args: ["trident", colored] }]);
	});

	it("undefined 删键并转发", () => {
		const bus = new StatusBus();
		const { ui, calls } = makeUI();
		bus.attach(ui);

		ui.setStatus("k", "x");
		ui.setStatus("k", undefined);

		assert.equal("k" in bus.getSnapshot().statuses, false);
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[1], { method: "setStatus", args: ["k", undefined] });
	});
});

describe("setWidget 记录 + 转发", () => {
	it("string[] 内容记录进快照并转发（含 options）", () => {
		const bus = new StatusBus();
		const { ui, calls } = makeUI();
		bus.attach(ui);

		ui.setWidget("plan-todos", ["a", "b"], { placement: "aboveEditor" });

		const w = bus.getSnapshot().widgets["plan-todos"];
		assert.deepEqual(w.content, { kind: "lines", lines: ["a", "b"] });
		assert.deepEqual(w.options, { placement: "aboveEditor" });
		assert.deepEqual(calls, [{ method: "setWidget", args: ["plan-todos", ["a", "b"], { placement: "aboveEditor" }] }]);
	});

	it("undefined 删键", () => {
		const bus = new StatusBus();
		const { ui } = makeUI();
		bus.attach(ui);

		ui.setWidget("plan-todos", ["a"]);
		ui.setWidget("plan-todos", undefined);

		assert.equal("plan-todos" in bus.getSnapshot().widgets, false);
	});
});

describe("JSON 契约（细粒度数据，渲染交给前端）", () => {
	it("组件工厂归一化为 factory 占位标记，不存函数", () => {
		const bus = new StatusBus();
		const { ui, calls } = makeUI();
		bus.attach(ui);

		const factory = () => ({});
		ui.setWidget("plan-todos", factory);

		const w = bus.getSnapshot().widgets["plan-todos"];
		assert.equal(w.content.kind, "factory");
		if (w.content.kind === "factory") {
			assert.equal(w.content.serialized, false);
			assert.equal(typeof w.content.note, "string");
		}
		// TUI 目标仍收到原函数，渲染不受影响
		assert.equal(calls[0].args[1], factory);
	});

	it("快照整体可 JSON 序列化且往返无损（含去 ANSI 纯文本）", () => {
		const bus = new StatusBus();
		const { ui } = makeUI();
		bus.attach(ui);

		ui.setStatus("a", "\x1b[33mwarning text\x1b[0m");
		ui.setWidget("w", ["x", "y"], { placement: "aboveEditor" });
		ui.setWorkingIndicator({ frames: ["●"], intervalMs: 500 });

		const parsed = JSON.parse(JSON.stringify(bus.getSnapshot()));
		assert.equal(parsed.statuses.a.text, "warning text");
		assert.deepEqual(parsed.widgets.w.content, { kind: "lines", lines: ["x", "y"] });
		assert.deepEqual(parsed.widgets.w.options, { placement: "aboveEditor" });
		assert.deepEqual(parsed.working.indicator, { frames: ["●"], intervalMs: 500 });
	});
});

describe("setWorking* 记录 + 转发", () => {
	it("message/visible/indicator 合并进 working，undefined 复位", () => {
		const bus = new StatusBus();
		const { ui, calls } = makeUI();
		bus.attach(ui);

		ui.setWorkingMessage("thinking…");
		ui.setWorkingVisible(true);
		ui.setWorkingIndicator({ frames: ["●"] });

		const working = bus.getSnapshot().working;
		assert.equal(working.message, "thinking…");
		assert.equal(working.visible, true);
		assert.deepEqual(working.indicator, { frames: ["●"] });

		ui.setWorkingMessage(undefined);
		ui.setWorkingIndicator(undefined);
		assert.equal("message" in bus.getSnapshot().working, false);
		assert.equal("indicator" in bus.getSnapshot().working, false);

		assert.equal(calls.length, 5);
		assert.deepEqual(calls[0], { method: "setWorkingMessage", args: ["thinking…"] });
		assert.deepEqual(calls[1], { method: "setWorkingVisible", args: [true] });
		assert.deepEqual(calls[2], { method: "setWorkingIndicator", args: [{ frames: ["●"] }] });
	});
});

describe("subscribe 变更流", () => {
	it("每次变更通知订阅者，退订后不再通知", () => {
		const bus = new StatusBus();
		const { ui } = makeUI();
		bus.attach(ui);

		const seen: string[] = [];
		const off = bus.subscribe((change) => seen.push(change.kind));

		ui.setStatus("a", "1");
		ui.setWorkingVisible(true);
		off();
		ui.setStatus("b", "2");

		assert.deepEqual(seen, ["status", "working"]);
	});

	it("订阅者抛错不影响转发", () => {
		const bus = new StatusBus();
		const { ui, calls } = makeUI();
		bus.attach(ui);

		bus.subscribe(() => {
			throw new Error("boom");
		});
		ui.setStatus("a", "1");

		assert.deepEqual(calls, [{ method: "setStatus", args: ["a", "1"] }]);
	});
});

describe("快照与重置", () => {
	it("version 随变更单调递增", () => {
		const bus = new StatusBus();
		const { ui } = makeUI();
		bus.attach(ui);

		const v0 = bus.getSnapshot().version;
		ui.setStatus("a", "1");
		ui.setWidget("w", ["x"]);
		assert.ok(bus.getSnapshot().version > v0);
	});

	it("reset 清空快照并发出 reset 变更", () => {
		const bus = new StatusBus();
		const { ui } = makeUI();
		bus.attach(ui);

		ui.setStatus("a", "1");
		ui.setWidget("w", ["x"]);
		ui.setWorkingVisible(true);

		const kinds: string[] = [];
		bus.subscribe((c) => kinds.push(c.kind));
		bus.reset();

		const snap = bus.getSnapshot();
		assert.deepEqual(snap.statuses, {});
		assert.deepEqual(snap.widgets, {});
		assert.deepEqual(snap.working, {});
		assert.ok(kinds.includes("reset"));
	});
});
