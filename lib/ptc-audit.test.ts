// lib/ptc-audit.test.ts — run_code 事前审核的纯函数与批准作用域
//
// 跑法：node --test --experimental-strip-types lib/ptc-audit.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	approvePtcScript,
	beginPtcScope,
	buildPtcAuditSubject,
	clearNestedCalls,
	clearPtcAudits,
	clearPtcScopes,
	describeTools,
	dryRunSummary,
	endPtcScope,
	notePtcAudit,
	recentPtcAudits,
	recordNestedCall,
	recordPtcExecution,
	scanSummary,
	scriptEffectsOf,
	summarizeArgs,
	takeNestedCalls,
	ptcRejectedText,
	ptcScopeForNestedCall,
	ptcScriptDigest,
	SELF_EVIDENT_TOOLS,
	longLiteralSpans,
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
		// 行号不摆：扫描那份文本与代码区显示那份不是同一份，摆出来会指错行
		assert.equal(summary.includes("12:5"), false);
		assert.ok(summary.includes("read 的参数里有非字面量"));
	});

	it("没给扫描结果时摘要为空（退回工具全集）", () => {
		assert.equal(scanSummary(undefined), "");
	});

	it("干跑摘要：预演到什么、或为什么没预演成", () => {
		assert.equal(dryRunSummary(undefined), "");
		const ok = dryRunSummary({ calls: [{ tool: "read", args: "" }, { tool: "read", args: "" }, { tool: "bash", args: "" }], status: "ok", ms: 12 });
		assert.match(ok, /干跑预演.*12ms.*会执行：read×2、bash/);
		assert.match(dryRunSummary({ calls: [], status: "ok", ms: 3 }), /没有派发任何调用/);
		assert.match(dryRunSummary({ calls: [{ tool: "read", args: "" }], status: "timeout", ms: 3000 }), /超时/);
		assert.match(dryRunSummary({ calls: [], status: "error", error: "引擎没起来", ms: 1 }), /引擎没起来/);
	});

	it("对账留痕：干跑多算的与真跑多出的都写进审计", () => {
		clearNestedCalls();
		clearPtcAudits();
		recordNestedCall("call-1", { tool: "bash", args: "{command:ls}", covered: true });
		recordNestedCall("call-1", { tool: "write", args: "{path:/tmp/x}", covered: true });
		const pi = { appendEntry: () => {} } as never;
		const result = recordPtcExecution(pi, {
			callId: "call-1",
			digest: "d1",
			reason: "跑一下",
			dry: { calls: [{ tool: "read", args: "" }, { tool: "bash", args: "" }], status: "ok", ms: 5 },
		});
		assert.deepEqual(result.comparison?.unpredicted, ["write"]);
		assert.deepEqual(result.comparison?.unfulfilled, ["read"]);
		const entry = recentPtcAudits(1)[0];
		assert.equal(entry.outcome, "executed");
		assert.deepEqual(entry.dryRun?.calls, ["read", "bash"]);
		assert.match(entry.compareLine ?? "", /真跑多出：write/);
		assert.match(entry.compareLine ?? "", /干跑多算：read/);
		clearPtcAudits();
		clearNestedCalls();
	});

	it("给审批窗的影响面是结构化的，没扫描也有摘要位", () => {
		const effects = scriptEffectsOf({
			script: "return await tools.bash({ command: 'ls' })",
			reason: "看看目录",
			tools: [],
			scan: { calls: [], tools: ["bash"], paths: [], commands: ["ls"], opaque: ["3:1 bash 的参数里有非字面量"] },
			dry: { calls: [{ tool: "bash", args: "" }], status: "ok", ms: 4 },
		});
		assert.deepEqual(effects.dryRunCalls, ["bash"]);
		assert.deepEqual(effects.tools, ["bash"]);
		assert.deepEqual(effects.commands, ["ls"]);
		assert.equal(effects.opaque.length, 1);
		assert.equal(effects.digestShort.length, 12);
		assert.equal(effects.parseError, undefined);

		const bare = scriptEffectsOf({ script: "return 1", reason: "空扫", tools: [] });
		assert.deepEqual(bare.tools, []);
		assert.equal(bare.digestShort.length, 12);
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

	it("内层调用按脚本归集，越界的单独列出来", () => {
		clearNestedCalls();
		recordNestedCall("call-1", { tool: "read", args: "{path:/a}", covered: true });
		recordNestedCall("call-1", { tool: "bash", args: "{command:ls}", covered: false });
		recordNestedCall("call-2", { tool: "read", args: "{path:/b}", covered: true });

		const log = takeNestedCalls("call-1");
		assert.deepEqual(log.calls.map((call) => call.tool), ["read", "bash"]);
		assert.deepEqual(log.outOfScope, ["bash"]);
		assert.equal(takeNestedCalls("call-1").calls.length, 0, "取走就清空");
		assert.equal(takeNestedCalls("call-2").calls.length, 1, "别的脚本不受影响");
		clearNestedCalls();
	});

	it("参数摘要压成一行并截断", () => {
		// 对象走 JSON：换行被转义，天然单行
		assert.equal(summarizeArgs({ command: "ls\n-a" }), '{"command":"ls\\n-a"}');
		// 字符串直接压平
		assert.equal(summarizeArgs("第一行\n第二行\t尾"), "第一行 第二行 尾");
		const long = summarizeArgs({ code: "x".repeat(500) });
		assert.ok(long.length <= 120, String(long.length));
		assert.ok(long.endsWith("…"));
	});

	it("审计条目内存滚动，最多留 50 条", () => {
		clearPtcAudits();
		for (let index = 0; index < 55; index++) {
			notePtcAudit({ ts: index, digest: `d${index}`, outcome: "approved", via: "preflight" });
		}
		const recent = recentPtcAudits(100);
		assert.equal(recent.length, 50);
		assert.equal(recent[0].digest, "d54", "新的在前");
		clearPtcAudits();
	});

	it("自明名单里都是常见工具名", () => {
		for (const name of ["read", "bash", "edit", "write", "subagent", "create_goal"]) {
			assert.ok(SELF_EVIDENT_TOOLS.has(name), name);
		}
		assert.ok(!SELF_EVIDENT_TOOLS.has("mcp__notes__write_note"));
	});
});

describe("approvePtcScript 送审", () => {
	// 两个接点都注进来：不打真网络、不弹真窗，只断言「送下去的是什么」
	function stubDeps(calls: unknown[][]) {
		return {
			reviewCommand: (async (...args: unknown[]) => {
				calls.push(args);
				return { verdict: "safe" as const, reason: "无风险", suggestion: "" };
			}) as never,
			channel: (async () => ({ action: "allow" as const })) as never,
		};
	}

	it("送审时标明场景是 ptc（分类器据此不再问 scripted_edit）", async () => {
		const calls: unknown[][] = [];
		const outcome = await approvePtcScript({
			pi: { appendEntry: () => {} } as never,
			ctx: {} as never,
			input: { script: "await bash('rm -rf /tmp/x')", reason: "清理临时目录", tools: [] },
			deps: stubDeps(calls),
		});
		assert.equal(calls.length, 1, "预审应该只跑一次");
		const args = calls[0];
		// 第 8 个参数（0 起数）是调用选项：场景与事实层走这里
		const options = args[7] as { scenario?: string };
		assert.equal(options?.scenario, "ptc");
		// 送审材料仍是有解释的那一段（不是裸脚本），理由在里面
		const subject = String(args[2]);
		assert.ok(subject.includes("【run_code 事前审核】"), subject.slice(0, 60));
		assert.ok(subject.includes("清理临时目录"));
		assert.ok(subject.includes("await bash('rm -rf /tmp/x')"));
		assert.equal(typeof outcome.approved, "boolean");
	});
});

	describe("长字面量的折叠范围", () => {
		it("超过 160 字符的字符串要折，短的不管", () => {
			const long = `"${"x".repeat(200)}"`;
			const short = '"ok"';
			assert.deepEqual(longLiteralSpans(long).length, 1);
			assert.deepEqual(longLiteralSpans(short).length, 0);
		});

		it("跨 5 行以上的数组要折，圆括号里的实参不折", () => {
			const array = "const a = [\n1,\n2,\n3,\n4,\n5,\n];";
			const args = "foo(\n1,\n2,\n3,\n4,\n5,\n)";
			assert.equal(longLiteralSpans(array).length, 1);
			assert.equal(longLiteralSpans(args).length, 0);
		});

		it("块里有真工具调用就豁免，if 块本身也不算大数组", () => {
			const withCall = "const a = [\n1,\n2,\ntools.read({ path: '/tmp/x' }),\n3,\n4,\n];";
			const ifBlock = "if (files.length > 0) {\n  a;\n  b;\n  c;\n  d;\n  e;\n}";
			assert.equal(longLiteralSpans(withCall).length, 0);
			assert.equal(longLiteralSpans(ifBlock).length, 0);
		});

		it("注释与字符串里的括号不参与配对", () => {
			const source = "// [\n/* ( ] */\nconst s = \"[[[\";\nconst a = [\n1,\n2,\n3,\n];";
			const spans = longLiteralSpans(source);
			assert.equal(spans.length, 1);
			assert.equal(source.slice(spans[0].startOffset, spans[0].endOffset).startsWith("["), true);
		});
	});

