// lib/timeline.test.ts — 增量输出的可读化（worker 里的脚本进度就走这条回流路径）
// 跑法：node --experimental-strip-types lib/timeline.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TimelineBuilder } from "./timeline.ts";

function build() {
	return new TimelineBuilder({ now: () => "2026-10-05T00:00:00.000Z" });
}

function toolOf(builder: TimelineBuilder, id: string) {
	return builder.events.find((event) => event.id === id);
}

describe("worker 流里的增量输出", () => {
	it("增量结果是文本段时，预览就是那行字（不是一屏 JSON）", () => {
		const timeline = build();
		assert.equal(
			timeline.handleLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "run_code", args: { code: "…" } })),
			true,
		);
		assert.equal(
			timeline.handleLine(
				JSON.stringify({
					type: "tool_execution_update",
					toolCallId: "t1",
					partialResult: { content: [{ type: "text", text: "bash: 读了三处配置" }] },
				}),
			),
			true,
			"原地更新也要报告变化，否则看板不会刷新",
		);
		assert.equal(toolOf(timeline, "t1")?.preview, "bash: 读了三处配置");
	});

	it("多段文本按行拼起来，空白段丢掉", () => {
		const timeline = build();
		timeline.handleLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "t2", toolName: "run_code" }));
		timeline.handleLine(
			JSON.stringify({
				type: "tool_execution_update",
				toolCallId: "t2",
				partialResult: { content: [{ type: "text", text: "第一步" }, { type: "text", text: "  " }, { type: "text", text: "第二步 " }] },
			}),
		);
		assert.equal(toolOf(timeline, "t2")?.preview, "第一步\n第二步");
	});

	it("抽不出文本就退回序列化（图片、结构化载荷）", () => {
		const timeline = build();
		timeline.handleLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "t3", toolName: "read" }));
		timeline.handleLine(
			JSON.stringify({ type: "tool_execution_update", toolCallId: "t3", partialResult: { content: [{ type: "image", data: "xx" }] } }),
		);
		assert.match(String(toolOf(timeline, "t3")?.preview), /image/);
	});

	it("没有 partialResult 时用事件里的参数做预览", () => {
		const timeline = build();
		timeline.handleLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "t4", toolName: "bash", args: { command: "git status" } }));
		// pi 的增量事件带 args（emitToolExecutionUpdate 里就有）
		timeline.handleLine(JSON.stringify({ type: "tool_execution_update", toolCallId: "t4", args: { command: "git status" } }));
		assert.match(String(toolOf(timeline, "t4")?.preview), /git status/);
	});

	it("空更新不擦掉已有预览（看板不该倒退）", () => {
		const timeline = build();
		timeline.handleLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "t5", toolName: "run_code" }));
		timeline.handleLine(
			JSON.stringify({ type: "tool_execution_update", toolCallId: "t5", partialResult: { content: [{ type: "text", text: "第三步" }] } }),
		);
		timeline.handleLine(JSON.stringify({ type: "tool_execution_update", toolCallId: "t5" }));
		assert.equal(toolOf(timeline, "t5")?.preview, "第三步");
	});

	it("更新落在没有 start 的调用上时安静忽略，不凭空造记录", () => {
		const timeline = build();
		assert.equal(
			timeline.handleLine(JSON.stringify({ type: "tool_execution_update", toolCallId: "ghost", partialResult: { content: [{ type: "text", text: "x" }] } })),
			false,
		);
		assert.equal(toolOf(timeline, "ghost"), undefined);
	});
});
