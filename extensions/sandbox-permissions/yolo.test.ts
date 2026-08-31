// yolo.test.ts — /yolo 会话级沙箱墙开关（状态翻转）测试
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/yolo.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setYolo, toggleYolo, yoloEnabled, yoloStatusText, YOLO_STATUS_KEY } from "./yolo.ts";

describe("/yolo 沙箱墙开关", () => {
	it("初始默认关闭（防护开启）", () => {
		setYolo(false);
		assert.equal(yoloEnabled(), false);
		assert.equal(yoloStatusText(), undefined);
	});

	it("setYolo 开启后状态为 on，状态文案非空", () => {
		setYolo(true);
		assert.equal(yoloEnabled(), true);
		assert.equal(yoloStatusText(), "🚀 YOLO");
	});

	it("toggle 往返：on → off → on", () => {
		setYolo(false);
		assert.equal(toggleYolo(), true);
		assert.equal(toggleYolo(), false);
		assert.equal(toggleYolo(), true);
	});

	it("关闭后状态文案为 undefined（供 status bar 清除）", () => {
		setYolo(false);
		assert.equal(yoloStatusText(), undefined);
	});

	it("status key 固定为 sandbox-yolo（与 guard 的 sandbox-guard 区分）", () => {
		assert.equal(YOLO_STATUS_KEY, "sandbox-yolo");
	});
});
