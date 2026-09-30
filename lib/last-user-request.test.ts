// last-user-request.test.ts
//
// 跑法：node --test --experimental-strip-types lib/last-user-request.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { flattenContent, lastUserRequest } from "./last-user-request.ts";

const userMsg = (content: unknown) => ({ type: "message", message: { role: "user", content } });
const assistantMsg = (content: unknown) => ({ type: "message", message: { role: "assistant", content } });

describe("flattenContent", () => {
	it("字符串直接用", () => {
		assert.equal(flattenContent("帮我清理构建产物"), "帮我清理构建产物");
	});

	it("块数组只取 text 块", () => {
		const content = [
			{ type: "text", text: "第一段" },
			{ type: "image", data: "xxx" },
			{ type: "text", text: "第二段" },
		];
		assert.equal(flattenContent(content), "第一段\n第二段");
	});

	it("thinking 块不进结果（那是模型的，不是用户要求）", () => {
		assert.equal(flattenContent([{ type: "thinking", thinking: "内部推理" }, { type: "text", text: "正事" }]), "正事");
	});

	it("非数组非字符串 → 空串", () => {
		assert.equal(flattenContent(undefined), "");
		assert.equal(flattenContent(42), "");
		assert.equal(flattenContent({ type: "text", text: "x" }), "");
	});
});

describe("lastUserRequest", () => {
	it("取最近一条用户消息", () => {
		const entries = [userMsg("第一句"), assistantMsg("回复"), userMsg("最后一句")];
		assert.equal(lastUserRequest(entries), "最后一句");
	});

	it("没有用户消息 → undefined", () => {
		assert.equal(lastUserRequest([assistantMsg("只有模型说话")]), undefined);
		assert.equal(lastUserRequest([]), undefined);
	});

	it("跳过空内容的用户消息（比如只有图片）", () => {
		const entries = [userMsg("有内容"), userMsg([{ type: "image", data: "x" }])];
		assert.equal(lastUserRequest(entries), "有内容");
	});

	it("忽略非 message 条目", () => {
		const entries = [userMsg("要求"), { type: "model_change" }, { type: "usage" }];
		assert.equal(lastUserRequest(entries), "要求");
	});

	it("超长时截断并加省略号", () => {
		const long = "x".repeat(3000);
		const out = lastUserRequest([userMsg(long)], 100);
		assert.equal(out?.length, 101); // 100 + 省略号
		assert.ok(out?.endsWith("…"));
	});

	it("块内容也能取到", () => {
		const entries = [userMsg([{ type: "text", text: "块形式的要求" }])];
		assert.equal(lastUserRequest(entries), "块形式的要求");
	});
});
