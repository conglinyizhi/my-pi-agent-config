// lib/ab-crash-report.test.ts — 崩溃报告（只写临时目录，不碰 ~/.pi/agent）
// 跑法：node --test --experimental-strip-types lib/ab-crash-report.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendCrashReport, crashReportPath, formatCrashReport, humanStamp, splitReports } from "./ab-crash-report.ts";

const REPORT = {
	at: "2026-10-05T04:30:00.000Z",
	component: "gui" as const,
	stage: "启动窗口",
	summary: "窗口启动失败：exit 133",
	module: "lib/approval-channel.ts:289（runGui）",
	error: { name: "Error", message: "spawn 失败", stack: "Error: spawn 失败\n    at runGui (lib/approval-channel.ts:289:5)" },
	context: { "请求文件": "/tmp/req.json", "槽": "dev", "退出码": 133, "没用的空值": undefined },
	files: ["/home/clyzhi/.pi/runtime/gui/crash/2026-10-05T04-30-00-000Z/scene.json"],
	hint: "先 make ab-detach COMPONENT=gui 回到仓库版本",
};

describe("崩溃报告", () => {
	it("标题一行就能看出该修什么", () => {
		const text = formatCrashReport(REPORT);
		const first = text.split("\n")[0] ?? "";
		assert.match(first, /^# \[/);
		assert.match(first, /\/\/ TODO 修：窗口启动失败：exit 133/);
		assert.match(first, /2026-10-05/);
	});

	it("详情里有模块、堆栈、上下文与相关文件", () => {
		const text = formatCrashReport(REPORT);
		assert.match(text, /崩溃模块：lib\/approval-channel\.ts:289/);
		assert.match(text, /at runGui/);
		assert.match(text, /## 调用上下文/);
		assert.match(text, /请求文件: \/tmp\/req\.json/);
		assert.match(text, /## 相关文件/);
		assert.match(text, /crash\/2026-10-05T04-30-00-000Z\/scene\.json/);
		assert.doesNotMatch(text, /没用的空值/, "空值不占行");
	});

	it("时间戳写成能直接读的样子", () => {
		assert.match(humanStamp("2026-10-05T04:30:00.000Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
		assert.equal(humanStamp("不是时间"), "不是时间");
	});

	it("追加：后一条在前一条之后", () => {
		const dir = mkdtempSync(join(tmpdir(), "crash-report-"));
		appendCrashReport(REPORT, { agentDir: dir });
		appendCrashReport({ ...REPORT, summary: "第二次", at: "2026-10-05T05:00:00.000Z" }, { agentDir: dir });
		const text = readFileSync(crashReportPath(dir), "utf8");
		assert.equal(splitReports(text).length, 2);
		assert.ok(text.lastIndexOf("第二次") > text.indexOf("窗口启动失败"));
	});

	it("报告文件是 0600：这种东西不该给同机其他用户看", () => {
		const dir = mkdtempSync(join(tmpdir(), "crash-report-"));
		const { path } = appendCrashReport(REPORT, { agentDir: dir });
		assert.equal(statSync(path).mode & 0o777, 0o600);
	});

	it("太长就只留最新的，别变成几千行没人看", () => {
		const dir = mkdtempSync(join(tmpdir(), "crash-report-"));
		for (let index = 0; index < 20; index += 1) {
			appendCrashReport({ ...REPORT, summary: `第 ${index} 次`, files: ["x".repeat(400)] }, { agentDir: dir, maxBytes: 2048 });
		}
		const text = readFileSync(crashReportPath(dir), "utf8");
		assert.ok(Buffer.byteLength(text, "utf8") <= 2048);
		assert.match(text, /第 19 次/, "最新的那条要在");
		assert.doesNotMatch(text, /第 0 次/, "最老的应该被丢掉");
	});
});
