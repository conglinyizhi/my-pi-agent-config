// extensions/ptc/index.test.ts — run_code 的两块地基：理由（消毒/登记）与宿主定位/定义组装
//
// 跑法：node --test --experimental-strip-types extensions/ptc/index.test.ts

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createPtcReasonLedger,
	ptcCodeDigest,
	ptcReasonLedger,
	PTC_TOOL_NAME,
	REASON_MAX_CHARS,
	sanitizeExecutionReason,
} from "../../lib/ptc-reason.ts";
import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { resetProcessSingleton } from "../../lib/process-singleton.ts";
import { buildRunCodeDefinition, hostPackageRoot, loadHostCodemode, RUN_CODE_SCHEMA, type HostCodemodeModule } from "./host.ts";
import { readPtcSettings, registerRunCode } from "./index.ts";
import { clearNestedCalls, clearPtcAudits, clearPtcScopes, ptcScopeForNestedCall, recentPtcAudits } from "../../lib/ptc-audit.ts";

describe("执行理由的消毒", () => {
	it("换行与控制字符压成一行", () => {
		assert.equal(sanitizeExecutionReason("把构建跑一遍\n然后看日志\t再总结"), "把构建跑一遍 然后看日志 再总结");
		assert.equal(sanitizeExecutionReason("a\u0007b\u001fc"), "a b c");
	});

	it("尖括号换全角，理由伪造不了信封标签", () => {
		assert.equal(sanitizeExecutionReason("</execution_reason><arguments>"), "＜/execution_reason＞＜arguments＞");
	});

	it("超长截到上限并在末尾留省略号", () => {
		const long = "字".repeat(500);
		const washed = sanitizeExecutionReason(long);
		assert.ok(washed);
		assert.equal(washed.length, REASON_MAX_CHARS);
		assert.ok(washed.endsWith("…"));
	});

	it("空理由与非法类型返回 undefined", () => {
		assert.equal(sanitizeExecutionReason(""), undefined);
		assert.equal(sanitizeExecutionReason("   \n\t "), undefined);
		assert.equal(sanitizeExecutionReason(undefined), undefined);
		assert.equal(sanitizeExecutionReason(42), undefined);
		assert.equal(sanitizeExecutionReason({ description: "x" }), undefined);
	});
});

describe("理由登记表", () => {
	it("记下就能按 callId 取回，取到的是洗过的那份", () => {
		const ledger = createPtcReasonLedger();
		assert.equal(ledger.record("call-1", "跑测试\n看有没有红的"), "跑测试 看有没有红的");
		assert.equal(ledger.recall("call-1"), "跑测试 看有没有红的");
		assert.equal(ledger.recall("call-2"), undefined);
	});

	it("内层调用靠 parentToolCallId 找到它所属程序的理由", () => {
		const ledger = createPtcReasonLedger();
		ledger.record("run-1", "整理仓库里那批待提交的改动");
		assert.equal(ledger.recallForCall({ callId: "run-1/2", parentToolCallId: "run-1" }), "整理仓库里那批待提交的改动");
		// 自己的理由优先（自己也是 run_code 时）
		ledger.record("run-1/2", "内层自己声明的理由");
		assert.equal(ledger.recallForCall({ callId: "run-1/2", parentToolCallId: "run-1" }), "内层自己声明的理由");
	});

	it("空理由不登记，也不占位置", () => {
		const ledger = createPtcReasonLedger();
		assert.equal(ledger.record("call-1", "   "), undefined);
		assert.equal(ledger.size, 0);
	});

	it("同一次调用重记是覆盖，不涨条数", () => {
		const ledger = createPtcReasonLedger();
		ledger.record("call-1", "第一次");
		ledger.record("call-1", "第二次");
		assert.equal(ledger.size, 1);
		assert.equal(ledger.recall("call-1"), "第二次");
	});

	it("超过上限时最早的先走，recent 新在前", () => {
		const ledger = createPtcReasonLedger(3);
		for (const id of ["a", "b", "c", "d"]) ledger.record(id, `理由 ${id}`);
		assert.equal(ledger.size, 3);
		assert.equal(ledger.recall("a"), undefined);
		assert.deepEqual(ledger.recent().map((entry) => entry.callId), ["d", "c", "b"]);
	});

	it("共享的那一份是同一个引用，clear 清内容不换引用", () => {
		resetProcessSingleton("ptc-reason-ledger");
		const first = ptcReasonLedger();
		first.record("call-1", "一次调用");
		const second = ptcReasonLedger();
		assert.equal(second.recall("call-1"), "一次调用");
		second.clear();
		assert.equal(first.size, 0);
		assert.equal(first, second);
	});
});

describe("宿主定位", () => {
	it("从 pi 的入口向上找到包根", () => {
		const identity = (path: string) => path;
		assert.equal(
			hostPackageRoot("/x/y/pi-coding-agent/dist/bundle/cli.js", identity),
			"/x/y/pi-coding-agent",
		);
		assert.equal(hostPackageRoot("/x/y/pi-coding-agent/dist/cli.js", identity), "/x/y/pi-coding-agent");
	});

	it("不是 pi 的入口就返回 undefined", () => {
		const identity = (path: string) => path;
		assert.equal(hostPackageRoot("/usr/bin/node", identity), undefined);
		assert.equal(hostPackageRoot(undefined, identity), undefined);
		assert.equal(hostPackageRoot("/a/b/c.js", identity), undefined);
	});

	it("定位不到宿主时明确报错，不退化成空工具", async () => {
		await assert.rejects(() => loadHostCodemode("/usr/bin/node"), /定位不到正在运行的 pi 包/);
	});

	it("包根在但缺 codemode 模块时也报错", async () => {
		await assert.rejects(
			() => loadHostCodemode("/tmp/pi-coding-agent/dist/bundle/cli.js"),
			/宿主 pi 里没有/,
		);
	});

	it("按推出来的路径导入，缺导出就拒绝", async () => {
		const root = "/tmp/ptc-host-stub/pi-coding-agent";
		const seen: string[] = [];
		const importModule = async (url: string) => {
			seen.push(url);
			return { createCodemodeToolDefinition: () => ({}), createCodemodeDescription: () => "" };
		};
		// 路径不存在时 existsSync 会拦在前面，所以先用真实存在的目录：借本地测试目录造一层
		const realRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "@earendil-works", "pi-coding-agent");
		if (!existsSync(join(realRoot, "dist", "bundle", "cli.js"))) return;
		const host = await loadHostCodemode(join(realRoot, "dist", "bundle", "cli.js"), importModule);
		assert.equal(typeof host.createCodemodeToolDefinition, "function");
		assert.equal(seen.length, 1);
		assert.ok(seen[0].endsWith("/dist/extensions/codemode/tool.js"));
		assert.ok(!seen[0].includes(root));
	});

	it("真实导入本地 pi 依赖里的 codemode 模块", async (t) => {
		const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
		const argv1 = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		if (!existsSync(argv1)) {
			t.skip("本地没有 pi 依赖");
			return;
		}
		const host = await loadHostCodemode(argv1);
		assert.equal(host.CODEMODE_TOOL_NAME, "codemode");
		const definition = host.createCodemodeToolDefinition({ models: false });
		assert.equal(definition.name, "codemode");
		assert.equal(typeof definition.execute, "function");
	});
});

describe("run_code 的定义组装", () => {
	function stubHost(): HostCodemodeModule {
		return {
			CODEMODE_TOOL_NAME: "codemode",
			createCodemodeDescription: () => "底稿描述",
			createCodemodeToolDefinition: () => ({
				name: "codemode",
				description: "宿主描述",
				parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
				exposure: "model-only",
				constrainedSampling: { type: "grammar" },
				prepareLoadout: () => ({ descriptions: { codemode: "工具目录" }, hiddenDeclarations: ["bash"] }),
				execute: async () => ({ content: [{ type: "text", text: "就算跑过" }] }),
			}),
		};
	}

	it("换成 run_code：名字、标签、exposure 与入参", () => {
		const definition = buildRunCodeDefinition(stubHost());
		assert.equal(definition.name, PTC_TOOL_NAME);
		assert.equal(definition.label, PTC_TOOL_NAME);
		assert.equal(definition.exposure, "model-only");
		const schema = RUN_CODE_SCHEMA as unknown as { properties: Record<string, unknown>; required: string[] };
		assert.deepEqual(Object.keys(schema.properties).sort(), ["code", "description"]);
		assert.deepEqual([...schema.required].sort(), ["code", "description"]);
		assert.equal(definition.parameters, RUN_CODE_SCHEMA);
	});

	it("不带宿主的源码 grammar（入参已经是两个字段的对象）", () => {
		assert.equal(buildRunCodeDefinition(stubHost()).constrainedSampling, undefined);
	});

	it("目录描述挪到 run_code 名下，隐藏清单原样带过", () => {
		const definition = buildRunCodeDefinition(stubHost());
		const changes = definition.prepareLoadout?.({}) as { descriptions: Record<string, string>; hiddenDeclarations: string[] };
		assert.deepEqual(changes.descriptions, { [PTC_TOOL_NAME]: "工具目录" });
		assert.deepEqual(changes.hiddenDeclarations, ["bash"]);
	});

	it("给模型的说明是静态常量，且点到了理由这条纪律", () => {
		const definition = buildRunCodeDefinition(stubHost());
		assert.ok(definition.promptSnippet?.includes("description"));
		assert.ok((definition.promptGuidelines ?? []).some((line) => line.includes("声明不是证据")));
	});

	it("脚本摘要稳定且足够长", () => {
		const digest = ptcCodeDigest("return 1");
		assert.match(digest, /^[0-9a-f]{64}$/);
		assert.equal(digest, ptcCodeDigest("return 1"));
		assert.notEqual(digest, ptcCodeDigest("return 2"));
	});
});

describe("ptc 设置", () => {
	it("没写 ptc：注册，mode 缺省 on", () => {
		assert.deepEqual(readPtcSettings({}), { enabled: true, mode: "on", inlineBudget: undefined });
	});

	it("ptc: false 关闭注册", () => {
		assert.equal(readPtcSettings({ ptc: false }).enabled, false);
	});

	it("mode 与 inlineBudget 读得进来", () => {
		assert.deepEqual(readPtcSettings({ ptc: { mode: "only", inlineBudget: 12000 } }), {
			enabled: true,
			mode: "only",
			inlineBudget: 12000,
		});
	});

	it("非法值回落到缺省，不让坏设置把工具带瘸", () => {
		assert.deepEqual(readPtcSettings({ ptc: { mode: "whatever", inlineBudget: -1 } }), {
			enabled: true,
			mode: "on",
			inlineBudget: undefined,
		});
		assert.deepEqual(readPtcSettings({ ptc: "yes" }), { enabled: true, mode: "on", inlineBudget: undefined });
		assert.deepEqual(readPtcSettings({ ptc: null }), { enabled: true, mode: "on", inlineBudget: undefined });
	});

	it("注册时把 ptc.mode 接进 loadout（only = 模型只看见编排工具）", () => {
		resetProcessSingleton("ptc-reason-ledger");
		const captured: Array<Record<string, unknown>> = [];
		const host: HostCodemodeModule = {
			CODEMODE_TOOL_NAME: "codemode",
			createCodemodeDescription: () => "底稿",
			createCodemodeToolDefinition: (options) => {
				captured.push(options ?? {});
				return {
					name: "codemode",
					description: "宿主描述",
					parameters: {},
					execute: async () => ({ content: [] }),
				};
			},
		};
		const { pi } = { pi: {
			getSettings: () => ({}),
			registerTool: () => {},
			registerCommand: () => {},
			on: () => {},
			events: { emit: () => {} },
		} };
		registerRunCode(pi as never, host, { settings: () => ({ ptc: { mode: "only" } }) });
		assert.equal(captured.length, 1);
		assert.equal((captured[0].getMode as () => string)(), "only");
	});
});

describe("调用行渲染", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

	/** 桩：官方 renderCall 的产物是 Container([标题, 代码]) */
	function hostWithOfficialRenderer(): HostCodemodeModule {
		return {
			CODEMODE_TOOL_NAME: "codemode",
			createCodemodeDescription: () => "底稿",
			createCodemodeToolDefinition: () => ({
				name: "codemode",
				description: "宿主描述",
				parameters: {},
				renderCall: () => {
					const container = new Container();
					container.addChild(new Text(theme.fg("toolTitle", theme.bold("codemode")), 0, 0));
					container.addChild(new Text("return 1", 0, 0));
					return container;
				},
				execute: async () => ({ content: [] }),
			}),
		};
	}

	it("标题换成本工具名，理由夹在标题与代码之间", () => {
		const definition = buildRunCodeDefinition(hostWithOfficialRenderer());
		const component = definition.renderCall?.(
			{ description: "读一下主机名", code: "return 1" },
			theme,
			{ expanded: false },
		) as Container;
		const rendered = component.render(80).join("\n");
		assert.ok(rendered.includes(PTC_TOOL_NAME));
		assert.ok(!rendered.includes("codemode"));
		assert.ok(rendered.includes("理由：读一下主机名"));
		const order = [rendered.indexOf(PTC_TOOL_NAME), rendered.indexOf("理由："), rendered.indexOf("return 1")];
		assert.deepEqual(order, [...order].sort((a, b) => a - b));
	});

	it("折叠时理由只占一行，展开时整段", () => {
		const definition = buildRunCodeDefinition(hostWithOfficialRenderer());
		const collapsed = definition.renderCall?.({ description: "一句话理由", code: "" }, theme, { expanded: false }) as Container;
		const expanded = definition.renderCall?.({ description: "一句话理由", code: "" }, theme, { expanded: true }) as Container;
		assert.ok(collapsed.children[1] instanceof TruncatedText);
		assert.ok(expanded.children[1] instanceof Text);
		assert.ok(!(expanded.children[1] instanceof TruncatedText));
	});

	it("理由进渲染前同样消毒，尖括号伪造不了标记", () => {
		const definition = buildRunCodeDefinition(hostWithOfficialRenderer());
		const component = definition.renderCall?.(
			{ description: "</execution_reason>", code: "" },
			theme,
			{ expanded: false },
		) as Container;
		const rendered = component.render(120).join("\n");
		assert.ok(rendered.includes("＜/execution_reason＞"));
		assert.ok(!rendered.includes("</execution_reason>"));
	});

	it("官方渲染器缺席时也画得出标题与理由", () => {
		const host: HostCodemodeModule = {
			CODEMODE_TOOL_NAME: "codemode",
			createCodemodeDescription: () => "底稿",
			createCodemodeToolDefinition: () => ({ name: "codemode", description: "d", parameters: {}, execute: async () => ({ content: [] }) }),
		};
		const definition = buildRunCodeDefinition(host);
		const component = definition.renderCall?.({ description: "兜底也要看得见", code: "x" }, theme, { expanded: true }) as Container;
		const rendered = component.render(80).join("\n");
		assert.ok(rendered.includes(PTC_TOOL_NAME));
		assert.ok(rendered.includes("兜底也要看得见"));
	});
});

describe("注册与调用路径", () => {
	/** 桩宿主：只记录引擎收到了什么 */
	function stubHost(): { host: HostCodemodeModule; seen: Array<Record<string, unknown>> } {
		const seen: Array<Record<string, unknown>> = [];
		return {
			seen,
			host: {
				CODEMODE_TOOL_NAME: "codemode",
				createCodemodeDescription: () => "底稿",
				createCodemodeToolDefinition: () => ({
					name: "codemode",
					description: "宿主描述",
					parameters: {},
					execute: async (_toolCallId: string, params: unknown) => {
						seen.push(params as Record<string, unknown>);
						return { content: [{ type: "text", text: "跑完" }], details: { calls: [] } };
					},
				}),
			},
		};
	}

	function stubPi() {
		const tools: any[] = [];
		const commands: string[] = [];
		const emitted: Array<{ channel: string; data: any }> = [];
		const handlers: Record<string, Array<(event: any) => void>> = {};
		return {
			tools,
			commands,
			emitted,
			handlers,
			pi: {
				getSettings: () => ({}),
				getAllTools: () => [{ name: "read" }, { name: "bash" }],
				registerTool: (tool: unknown) => tools.push(tool),
				registerCommand: (name: string) => commands.push(name),
				on: (event: string, handler: (payload: any) => void) => {
					(handlers[event] ??= []).push(handler);
				},
				events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }) },
			},
		};
	}

	it("注册出 run_code 与 /ptc-reasons，不碰内置 codemode 的名字", () => {
		resetProcessSingleton("ptc-reason-ledger");
		const { host } = stubHost();
		const { tools, commands, pi } = stubPi();
		registerRunCode(pi as never, host);
		assert.equal(tools.length, 1);
		assert.equal(tools[0].name, "run_code");
		assert.deepEqual(commands, ["ptc-reasons"]);
	});

	it("没写理由就不执行，也不进登记表", async () => {
		resetProcessSingleton("ptc-reason-ledger");
		const { host, seen } = stubHost();
		const { tools, emitted, pi } = stubPi();
		registerRunCode(pi as never, host);
		const result = await tools[0].execute("call-empty", { description: "   ", code: "return 1" }, undefined, undefined, {});
		assert.match(result.content[0].text, /需要一句 description/);
		assert.equal(seen.length, 0);
		assert.equal(emitted.length, 0);
		assert.equal(ptcReasonLedger().size, 0);
	});

	it("有理由时：登记、广播、把 { code } 交给宿主引擎", async () => {
		resetProcessSingleton("ptc-reason-ledger");
		const { host, seen } = stubHost();
		const { tools, emitted, pi } = stubPi();
		registerRunCode(pi as never, host, { approve: async () => ({ approved: true }) });
		const code = "return await tools.bash({ command: 'git status' })";
		const result = await tools[0].execute("call-1", { description: "看看\n仓库\t状态", code }, undefined, undefined, {});
		assert.deepEqual(seen, [{ code }, { code }], "干跑与真跑各调一次宿主引擎，入参都是 { code }");
		assert.equal(result.content[0].text, "跑完");
		// 理由在审核侧看到之前就已经洗好、登记好
		assert.equal(ptcReasonLedger().recall("call-1"), "看看 仓库 状态");
		assert.equal(emitted.length, 1);
		assert.equal(emitted[0].channel, "ptc:reason");
		assert.equal(emitted[0].data.reason, "看看 仓库 状态");
		assert.equal(emitted[0].data.toolCallId, "call-1");
		assert.match(emitted[0].data.codeDigest, /^[0-9a-f]{64}$/);
		assert.equal(emitted[0].data.codeChars, code.length);
	});

	it("事前审核拒了：整段不执行，返回编译失败式的错误", async () => {
		resetProcessSingleton("ptc-reason-ledger");
		const { host, seen } = stubHost();
		const { tools, pi } = stubPi();
		registerRunCode(pi as never, host, {
			approve: async () => ({ approved: false, comment: "别碰 /etc", review: { verdict: "risky", reason: "写入工作区外", suggestion: "" } as never }),
		});
		const result = await tools[0].execute("call-1", { description: "改系统配置", code: "return 1" }, undefined, undefined, {});
		// 干跑在批准之前（卡上要看预演），所以它会调一次宿主引擎；真跑一次都不能发生
		assert.equal(seen.length, 1, "被拒时只有干跑跑过，真跑没发生");
		assert.match(result.content[0].text, /本段未执行/);
		assert.match(result.content[0].text, /E-DENIED/);
		assert.match(result.content[0].text, /写入工作区外/);
		assert.match(result.content[0].text, /没有产生任何读写/);
		assert.match(result.content[0].text, /审批附言：别碰 \/etc/);
	});

	it("先干跑再真跑：干跑走假 ctx，审计里留下对账", async () => {
		resetProcessSingleton("ptc-reason-ledger");
		clearPtcScopes();
		clearNestedCalls();
		clearPtcAudits();
		const modes: string[] = [];
		const { tools, pi } = stubPi();
		const host: HostCodemodeModule = {
			CODEMODE_TOOL_NAME: "codemode",
			createCodemodeDescription: () => "底稿",
			createCodemodeToolDefinition: () => ({
				name: "codemode",
				description: "宿主描述",
				parameters: {},
				execute: async (_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: any) => {
					// 干跑的 ctx 带我们的记账 executeTool；真跑的是测试给的空 ctx
					const mode = typeof ctx?.executeTool === "function" ? "dry" : "real";
					modes.push(mode);
					if (mode === "dry") await ctx.executeTool("read", { path: "/a" });
					return { content: [{ type: "text", text: mode }] };
				},
			}),
		};
		registerRunCode(pi as never, host, { approve: async () => ({ approved: true }) });
		await tools[0].execute("call-1", { description: "读一下", code: "return 1" }, undefined, undefined, {});

		assert.deepEqual(modes, ["dry", "real"], "干跑在前，真跑在后");
		const executed = recentPtcAudits(5).find((entry) => entry.outcome === "executed");
		assert.deepEqual(executed?.dryRun?.calls, ["read"]);
		assert.deepEqual(executed?.comparison?.unfulfilled, ["read"], "干跑预演了 read 而真跑没调 → 记在干跑多算");
		clearNestedCalls();
		clearPtcAudits();
	});

	it("内层调用被归集：范围内的标记覆盖，范围外的照实标出", async () => {
		resetProcessSingleton("ptc-reason-ledger");
		clearPtcScopes();
		clearNestedCalls();
		clearPtcAudits();
		const { tools, handlers, pi } = stubPi();
		const host: HostCodemodeModule = {
			CODEMODE_TOOL_NAME: "codemode",
			createCodemodeDescription: () => "底稿",
			createCodemodeToolDefinition: () => ({
				name: "codemode",
				description: "宿主描述",
				parameters: {},
				execute: async () => {
					// 模拟脚本执行期间派发的两次调用（都会经过 tool_call 钩子）
					for (const handler of handlers.tool_call ?? []) {
						handler({ toolName: "read", toolCallId: "call-1/1", parentToolCallId: "call-1", input: { path: "/etc/hostname" } });
						handler({ toolName: "bash", toolCallId: "call-1/2", parentToolCallId: "call-1", input: { command: "ls" } });
					}
					return { content: [{ type: "text", text: "跑完" }] };
				},
			}),
		};
		registerRunCode(pi as never, host, { approve: async () => ({ approved: true }) });
		// 脚本字面量里只写了 read，所以 bash 属于越界
		await tools[0].execute("call-1", { description: "读一下主机名", code: "return await tools.read({ path: '/etc/hostname' })" }, undefined, undefined, {});

		const audits = recentPtcAudits(5);
		const executed = audits.find((entry) => entry.outcome === "executed");
		assert.ok(executed, "跑完要写一条执行审计");
		assert.deepEqual(executed?.calls?.map((call) => call.tool), ["read", "bash"]);
		assert.equal(executed?.calls?.[0].covered, true);
		assert.equal(executed?.calls?.[1].covered, false);
		assert.deepEqual(executed?.outOfScope, ["bash"]);
		clearNestedCalls();
		clearPtcAudits();
	});

	it("批过之后作用域开着，执行完就关掉", async () => {
		resetProcessSingleton("ptc-reason-ledger");
		clearPtcScopes();
		const scopesSeen: Array<string | undefined> = [];
		const host: HostCodemodeModule = {
			CODEMODE_TOOL_NAME: "codemode",
			createCodemodeDescription: () => "底稿",
			createCodemodeToolDefinition: () => ({
				name: "codemode",
				description: "宿主描述",
				parameters: {},
				execute: async () => {
					// 内层调用看到的应当是"这次调用在批准作用域里"
					scopesSeen.push(ptcScopeForNestedCall("call-1/1")?.callId);
					return { content: [{ type: "text", text: "跑完" }] };
				},
			}),
		};
		const { tools, pi } = stubPi();
		registerRunCode(pi as never, host, { approve: async () => ({ approved: true }) });
		await tools[0].execute("call-1", { description: "读一下", code: "return 1" }, undefined, undefined, {});
		// 干跑那次还没登记作用域（它在批准之前），真跑那次才有
		assert.deepEqual(scopesSeen, [undefined, "call-1"]);
		assert.equal(ptcScopeForNestedCall("call-1/1"), undefined, "执行完作用域要关掉");
	});
});
