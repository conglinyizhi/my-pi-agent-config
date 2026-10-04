// 跑法：node --test gui/electron/init-data.test.mjs
//
// 这份映射是宿主与前端之间的契约（等价于 wails-gui/app.go 的 GetInitData），
// 字段少一个，窗口就是"能打开但少显示一块"，所以在测试里钉住。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_WINDOW, WINDOW_CONFIGS, buildInitData, parseArgv } from "./init-data.js";

describe("argv 解析", () => {
	it("从 electron 的 argv 里取窗口名与两个文件", () => {
		const parsed = parseArgv(["/usr/bin/electron", "/x/gui/electron/main.js", "gate", "/tmp/req.json", "/tmp/resp.json"]);
		assert.deepEqual(parsed, { windowName: "gate", requestFile: "/tmp/req.json", responseFile: "/tmp/resp.json" });
	});

	it("缺参数时退回默认窗口，不抛错", () => {
		const parsed = parseArgv(["/usr/bin/electron", "/x/gui/electron/main.js"]);
		assert.equal(parsed.windowName, DEFAULT_WINDOW);
		assert.equal(parsed.requestFile, "");
	});

	it("四个窗口的配置齐备", () => {
		for (const name of ["gate", "editor", "subagents", "routing"]) {
			const config = WINDOW_CONFIGS[name];
			assert.ok(config, name);
			assert.ok(config.title.length > 0 && config.width > 0 && config.minWidth <= config.width, name);
		}
	});
});

describe("initData 映射", () => {
	it("gate：PTC 字段原样铺开（subject / scriptEffects 是这次新加的）", () => {
		const request = {
			command: "return 1",
			reason: "理由",
			subject: "script",
			scriptEffects: { tools: ["bash"], dryRunCalls: ["bash"], dryRunStatus: "ok", digestShort: "abc123456789" },
			kind: "audit",
			review: { verdict: "risky" },
			timeout: 30,
			builtinRoots: ["/tmp"],
		};
		const data = buildInitData("gate", request, { responseFile: "/tmp/resp.json" });
		assert.equal(data.responseFile, "/tmp/resp.json");
		assert.equal(data.subject, "script");
		assert.deepEqual(data.scriptEffects.tools, ["bash"]);
		assert.equal(data.review.verdict, "risky");
		assert.equal(data.timeout, 30);
		assert.deepEqual(data.builtinRoots, ["/tmp"]);
	});

	it("缺字段保持缺（前端按「缺就不渲染」处理，别自作主张补默认值）", () => {
		const data = buildInitData("gate", {}, {});
		assert.equal(data.command, undefined);
		assert.equal(data.scriptEffects, undefined);
		assert.ok("command" in data, "键要在，值可以是 undefined");
	});

	it("其它窗口各取自己那一段", () => {
		assert.deepEqual(buildInitData("subagents", { workers: [1] }, {}).workers, [1]);
		assert.deepEqual(buildInitData("routing", { todos: [2] }, {}).todos, [2]);
		assert.deepEqual(buildInitData("editor", { clipHistory: [3] }, {}).clipHistory, [3]);
	});

	it("未知窗口名按 gate 处理，请求不是对象也不炸", () => {
		const data = buildInitData("nope", null, {});
		assert.ok("command" in data);
	});
});
