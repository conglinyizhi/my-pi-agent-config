// lib/ptc-audit.test.ts — run_code 事前审核的纯函数与批准作用域
//
// 跑法：node --test --experimental-strip-types lib/ptc-audit.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	beginPtcScope,
	buildPtcAuditSubject,
	clearPtcScopes,
	describeTools,
	endPtcScope,
	scanSummary,
	ptcRejectedText,
	ptcScopeForNestedCall,
	ptcScriptDigest,
	SELF_EVIDENT_TOOLS,
	type PtcToolInfo,
} from "./ptc-audit.ts";

describe("脚本摘要", () => {
	it("同脚本同摘要，不同脚本不同摘要", () => {
		const digest = ptcScriptDigest("return 1");
		assert.match(digest, /^[0-9a-f]{64}$/);
		assert.equal(digest, ptcScriptDigest("return 1"));
		assert.notEqual(digest, ptcScriptDigest("return 2"));
	});
});

describe("工具面（送审材料）", () => {
	const tools: PtcToolInfo[] = [
		{ name: "read" },
		{ name: "bash" },
		{ name: "subagent", description: "派 worker" },
		{
			name: "mcp__notes__write_note",
			description: "写入一条笔记\n后面还有别的行，不该带进来",
			annotations: { destructiveHint: true, openWorldHint: true },
		},
		{ name: "todo_write", description: "记录任务列表" },
	];

	it("自明的只列名字，不漏进描述段", () => {
		const text = describeTools(tools);
		assert.ok(text.includes("read、bash"), text);
		const described = text.split("可能调用的工具")[1] ?? "";
		assert.ok(!described.includes("- read:"), "自明工具不该带描述");
	});

	it("其余工具附描述与注解提示", () => {
		const text = describeTools(tools);
		assert.ok(text.includes("- mcp__notes__write_note（可破坏、触达外部）"), text);
		assert.ok(text.includes("写入一条笔记"), text);
		assert.ok(!text.includes("后面还有别的行"), "描述只取第一行");
	});

	it("描述条目有上限", () => {
		const many: PtcToolInfo[] = Array.from({ length: 40 }, (_, index) => ({
			name: `mcp__srv__tool_${index}`,
			description: `工具 ${index}`,
		}));
		const lines = describeTools(many).split("\n").filter((line) => line.startsWith("- "));
		assert.equal(lines.length, 20);
	});

	it("给了扫描结果就只描述用到的工具，其余只报个数", () => {
		const text = describeTools(tools, ["mcp__notes__write_note"]);
		assert.ok(text.includes("mcp__notes__write_note"));
		assert.ok(!text.includes("- todo_write:"), "没用到的不该带描述");
		assert.ok(text.includes("其它工具，共 5 个"), text);
	});

	it("扫描摘要列出工具、路径、命令与看不清的地方", () => {
		const summary = scanSummary({
			calls: [],
			tools: ["read", "bash"],
			paths: ["/etc/x", "src/a.ts"],
			commands: ["ls"],
			opaque: ["12:5 read 的参数里有非字面量"],
		});
		assert.ok(summary.includes("read、bash"));
		assert.ok(summary.includes("/etc/x"));
		assert.ok(summary.includes('"ls"'));
		assert.ok(summary.includes("看不清的地方"));
		assert.ok(summary.includes("12:5"));
	});

	it("没给扫描结果时摘要为空（退回工具全集）", () => {
		assert.equal(scanSummary(undefined), "");
	});

	it("送审文本把理由、工具面、脚本原文都带上", () => {
		const subject = buildPtcAuditSubject({ script: "return await tools.read({ path: '/a' })", reason: "核对工作区", tools });
		assert.ok(subject.includes("核对工作区"));
		assert.ok(subject.includes("return await tools.read"));
		assert.ok(subject.includes("mcp__notes__write_note"));
		assert.ok(subject.includes("事前审核"));
	});
});

describe("拒绝时的返回", () => {
	it("照编译器报错的样子：错误码 + 理由 + 零副作用声明", () => {
		const text = ptcRejectedText("写入路径超出批准范围：/etc/hosts");
		assert.ok(text.includes("本段未执行"));
		assert.ok(text.includes("E-DENIED"));
		assert.ok(text.includes("写入路径超出批准范围：/etc/hosts"));
		assert.ok(text.includes("没有产生任何读写"));
		assert.ok(text.includes("报给主 agent"));
	});

	it("带审批附言时附在末尾", () => {
		assert.ok(ptcRejectedText("越界", "别写 /etc").includes("审批附言：别写 /etc"));
	});
});

describe("批准作用域", () => {
	it("内层调用按 id 链反查到父脚本", () => {
		clearPtcScopes();
		beginPtcScope("call-1", ptcScriptDigest("script A"));
		assert.equal(ptcScopeForNestedCall("call-1")?.callId, "call-1");
		assert.equal(ptcScopeForNestedCall("call-1/1")?.callId, "call-1");
		assert.equal(ptcScopeForNestedCall("call-1/1/2")?.callId, "call-1");
		assert.equal(ptcScopeForNestedCall("call-2/1"), undefined);
		assert.equal(ptcScopeForNestedCall(undefined), undefined);
	});

	it("两段脚本并行跑时互不蹭批准", () => {
		clearPtcScopes();
		beginPtcScope("call-a", ptcScriptDigest("A"));
		beginPtcScope("call-b", ptcScriptDigest("B"));
		assert.equal(ptcScopeForNestedCall("call-a/3")?.scriptDigest, ptcScriptDigest("A"));
		assert.equal(ptcScopeForNestedCall("call-b/1")?.scriptDigest, ptcScriptDigest("B"));
		endPtcScope("call-a");
		assert.equal(ptcScopeForNestedCall("call-a/3"), undefined);
		assert.ok(ptcScopeForNestedCall("call-b/1"), "另一段脚本的作用域不受影响");
		clearPtcScopes();
		assert.equal(ptcScopeForNestedCall("call-b/1"), undefined);
	});

	it("自明名单里都是常见工具名", () => {
		for (const name of ["read", "bash", "edit", "write", "subagent", "create_goal"]) {
			assert.ok(SELF_EVIDENT_TOOLS.has(name), name);
		}
		assert.ok(!SELF_EVIDENT_TOOLS.has("mcp__notes__write_note"));
	});
});
