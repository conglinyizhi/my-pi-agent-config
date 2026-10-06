// llm-review.test.ts — gate LLM 预审层纯函数测试
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/llm-review.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import { factsFromReport } from "../../lib/preshell.ts";
import {
	buildClassifierReviewInput,
	buildReviewPrompt,
	createReviewCache,
	extractReviewResult,
	formatReviewNote,
	toAdvisorNote,
	normalizeConfig,
	reviewCacheKey,
	reviewCommand,
} from "./llm-review.ts";
import type { TokenRule } from "./rule-engine.ts";

const rule = (name: string, matched: string[] = []): TokenRule => ({
	name,
	tip: `${name} tip`,
	matched,
});

describe("normalizeConfig", () => {
	it("缺省 → 默认配置（enabled=true, mode=auto）", () => {
		const c = normalizeConfig(undefined);
		assert.equal(c.enabled, true);
		assert.equal(c.mode, "auto");
		assert.equal(c.timeoutMs, 30_000);
		assert.equal(c.tokenIdleMs, 4_000);
		assert.equal(c.maxCache, 200);
	});
	it("低风险放行：默认开、阈值 40；可关可调", () => {
		const c = normalizeConfig(undefined);
		assert.equal(c.lowRiskAuto, true);
		assert.equal(c.lowRiskBudget, 40);
		assert.equal(normalizeConfig({ low_risk_auto: false }).lowRiskAuto, false);
		assert.equal(normalizeConfig({ low_risk_budget: 20 }).lowRiskBudget, 20);
		// 60 是「严重」那一档，不参与低风险放行，配了也不认
		assert.equal(normalizeConfig({ low_risk_budget: 60 }).lowRiskBudget, 40);
	});
	it("覆盖已知字段（toml 下划线风格）、忽略未知字段", () => {
		const c = normalizeConfig({
			enabled: false,
			mode: "strict",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			timeout_ms: 5000,
			token_idle_ms: 3000,
			max_cache: 50,
			bogus: 1,
		});
		assert.equal(c.enabled, false);
		assert.equal(c.mode, "strict");
		assert.equal(c.provider, "deepseek");
		assert.equal(c.model, "deepseek-v4-flash");
		assert.equal(c.timeoutMs, 5000);
		assert.equal(c.tokenIdleMs, 3000);
		assert.equal(c.maxCache, 50);
	});
	it("模型池：解析 models 数组，跳过结构非法条目", () => {
		const c = normalizeConfig({
			models: [
				{ provider: "zhipu", model: "glm-4.7-flash" },
				{ provider: "deepseek", model: "deepseek-v4-flash" },
				{ provider: "x" }, // 缺 model → 跳过
				"not-an-object", // 非对象 → 跳过
			],
		});
		assert.deepEqual(c.models, [
			{ provider: "zhipu", model: "glm-4.7-flash" },
			{ provider: "deepseek", model: "deepseek-v4-flash" },
		]);
	});
	it("models 优先于旧 provider/model 单配置", () => {
		const c = normalizeConfig({
			models: [{ provider: "zhipu", model: "glm-4.7-flash" }],
			provider: "deepseek",
			model: "deepseek-v4-flash",
		});
		assert.deepEqual(c.models, [{ provider: "zhipu", model: "glm-4.7-flash" }]);
		assert.equal(c.provider, undefined);
		assert.equal(c.model, undefined);
	});
	it("无 models 时兼容旧 provider/model 单配置", () => {
		const c = normalizeConfig({ provider: "deepseek", model: "deepseek-v4-flash" });
		assert.equal(c.models, undefined);
		assert.equal(c.provider, "deepseek");
		assert.equal(c.model, "deepseek-v4-flash");
	});
	it("非法值回退默认", () => {
		const c = normalizeConfig({ enabled: "yes", mode: "auto", timeout_ms: -3, max_cache: 0 });
		assert.equal(c.enabled, true);
		assert.equal(c.mode, "auto");
		assert.equal(c.timeoutMs, 30_000);
		assert.equal(c.tokenIdleMs, 4_000);
		assert.equal(c.maxCache, 200);
	});
	it("真实 toml 文本解析后 normalize 生效", () => {
		const doc = parseToml(`
[sandbox-llm-review]
enabled = true
mode = "auto"
timeout_ms = 8000
token_idle_ms = 6500
max_cache = 50
`) as Record<string, unknown>;
		const c = normalizeConfig(doc["sandbox-llm-review"]);
		assert.equal(c.enabled, true);
		assert.equal(c.mode, "auto");
		assert.equal(c.timeoutMs, 8000);
		assert.equal(c.tokenIdleMs, 6500);
		assert.equal(c.maxCache, 50);
	});
});

describe("buildReviewPrompt", () => {
	const SYSTEM = "你是一个专业的 Linux 运维人员，审核 shell 指令是否安全。";
	it("包含命令与命中规则", () => {
		const { system, user } = buildReviewPrompt(SYSTEM, "rm -rf /tmp/build", [rule("rm-recursive", ["-rf"])]);
		assert.equal(system, SYSTEM);
		assert.ok(system.includes("Linux 运维人员"));
		assert.ok(user.includes("rm -rf /tmp/build"));
		assert.ok(user.includes("rm-recursive"));
		assert.ok(user.includes("-rf"));
	});
	it("无规则时给出动态构造提示", () => {
		const { user } = buildReviewPrompt(SYSTEM, "echo $(date)", []);
		assert.ok(user.includes("动态构造"));
	});
	it("超长命令截断", () => {
		const { user } = buildReviewPrompt(SYSTEM, "x".repeat(5000), []);
		assert.ok(user.includes("已截断"));
		assert.ok(user.length < 4600);
	});
	it("事实层跟着命令一起给：解释器载荷原文、截断信号、工具自报的问题", () => {
		// 审核模型看不到命令行上那段 python 代码时，只能看见「跑了 python3」，等于没审
		const facts = factsFromReport(
			{
				status: "Complete",
				impact: {
					effects: [
						{
							kind: "Exec",
							target: "python3",
							modeled: false,
							line: 1,
							payload: { source: "flag", flag: "-c", text: 'import os; os.remove("/tmp/x")', bytes: 30, truncated: false },
						},
					],
					write_roots: [],
					uncertain: true,
					effects_dropped: 2,
					vars: [],
					cwd: "/tmp",
				},
				issues: [{ kind: "Syntax", message: "unterminated ${", line: 1 }],
				issues_dropped: 0,
			},
			{ cwd: "/tmp" },
		);
		const { user } = buildReviewPrompt(SYSTEM, 'python3 -c \'import os; os.remove("/tmp/x")\'', [], facts);
		assert.ok(user.includes("## 指令影响面"));
		assert.ok(user.includes("（静态分析事实，不是裁决）"));
		assert.ok(user.includes("解释器载荷"), "载荷那一段要在 prompt 里");
		assert.ok(user.includes('import os; os.remove("/tmp/x")'), "载荷原文要在 prompt 里");
		assert.ok(user.includes("清单不完整"), "截断信号要在 prompt 里");
		assert.ok(user.includes("effects 还有 2 条未列出"));
		assert.ok(user.includes("unterminated ${"), "工具自报的 issues 要在 prompt 里");
	});
});

describe("extractReviewResult（文本协议）", () => {
	const text = (t: string) => ({ type: "text" as const, text: t });

	it("[ok] → 可行，不带理由 / 档位 / 看法", () => {
		assert.deepEqual(extractReviewResult([text("[ok]")]), { verdict: "safe", reason: "", suggestion: "" });
	});

	it("[ok] 大小写不敏感，容忍空白、括号内空格、装饰与收尾标点", () => {
		for (const raw of ["[OK]", "[Ok]", "  [ok]  ", "[ ok ]", "**[ok]**", "`[ok]`", "[ok]。"]) {
			assert.equal(extractReviewResult([text(raw)]).verdict, "safe", raw);
		}
	});

	it("[ok] 后面另有说明 → 按风险处理（协议要求整段只有 [ok]）", () => {
		const r = extractReviewResult([text("[ok]\n不过建议先备份")]);
		assert.notEqual(r.verdict, "safe");
	});

	it("[<20] → 轻微风险：risky + 档位 20，标记不进理由", () => {
		const r = extractReviewResult([text("[<20]\n建议改用绝对路径")]);
		assert.deepEqual(r, { verdict: "risky", reason: "建议改用绝对路径", suggestion: "", riskBudget: 20 });
	});

	it("[40] → risky + 档位 40", () => {
		const r = extractReviewResult([text("[40]\n删除路径含通配符，可能误删目标外的文件")]);
		assert.equal(r.verdict, "risky");
		assert.equal(r.riskBudget, 40);
		assert.equal(r.reason, "删除路径含通配符，可能误删目标外的文件");
		assert.equal("opinion" in r, false);
	});

	it("[60] → dangerous + 档位 60", () => {
		const r = extractReviewResult([text("[60]\n提权后做破坏性操作，可能损毁系统")]);
		assert.equal(r.verdict, "dangerous");
		assert.equal(r.riskBudget, 60);
	});

	it("[< 20] 这类带空格写法也认", () => {
		assert.equal(extractReviewResult([text("[< 20]\n小隐患")]).riskBudget, 20);
	});

	it("说明写超了档位字数：展示侧照原样给（档位管模型写多长，卡片不按它裁）", () => {
		const r = extractReviewResult([text(`[<20]\n${"字".repeat(50)}`)]);
		assert.equal(r.reason.length, 50, r.reason);
		assert.equal(r.riskBudget, 20);
		assert.equal(r.verdict, "risky");
	});

	it("没写档位标记（协议漂了）→ 按说明字数落档，原文留在 opinion 里", () => {
		const short = extractReviewResult([text("路径含变量拼接，无法静态确认")]);
		assert.equal(short.verdict, "risky");
		assert.equal(short.riskBudget, 20);
		assert.equal(short.opinion, "路径含变量拼接，无法静态确认");

		const long = extractReviewResult([text("字".repeat(50))]);
		assert.equal(long.verdict, "dangerous");
		assert.equal(long.riskBudget, 60);
	});

	it("多段文本拼接后再判定，换行与空格不影响标记识别", () => {
		const r = extractReviewResult([text("[40]"), text("\n  目标目录不是临时目录")]);
		assert.equal(r.verdict, "risky");
		assert.equal(r.reason, "目标目录不是临时目录");
	});

	it("空回复 → error（回退弹窗），不带 opinion", () => {
		const r = extractReviewResult([]);
		assert.equal(r.verdict, "error");
		assert.equal("opinion" in r, false);
	});

	it("只有档位标记、没有说明 → 按档位判，理由留空", () => {
		const r = extractReviewResult([text("[60]")]);
		assert.deepEqual(r, { verdict: "dangerous", reason: "", suggestion: "", riskBudget: 60 });
	});
});

describe("reviewCacheKey", () => {
	it("同命令同规则 → 同 key", () => {
		assert.equal(
			reviewCacheKey("rm -rf /tmp/x", [rule("rm-recursive", ["-rf"])]),
			reviewCacheKey("rm -rf /tmp/x", [rule("rm-recursive", ["-rf"])]),
		);
	});
	it("规则顺序不影响 key（按 name 排序）", () => {
		assert.equal(
			reviewCacheKey("a", [rule("z"), rule("a")]),
			reviewCacheKey("a", [rule("a"), rule("z")]),
		);
	});
	it("不同命令 → 不同 key", () => {
		assert.notEqual(reviewCacheKey("rm -rf /tmp/x", []), reviewCacheKey("rm -rf /tmp/y", []));
	});
	it("matched 不同 → 不同 key", () => {
		assert.notEqual(
			reviewCacheKey("x", [rule("r", ["-rf"])]),
			reviewCacheKey("x", [rule("r", ["-r"])]),
		);
	});
});

describe("createReviewCache", () => {
	it("set/get 命中，未命中返回 undefined", () => {
		const c = createReviewCache();
		c.set("k", { verdict: "safe", reason: "ok", suggestion: "" });
		assert.equal(c.get("k")?.verdict, "safe");
		assert.equal(c.get("nope"), undefined);
	});
	it("超上限淘汰最旧（LRU）", () => {
		const c = createReviewCache(2);
		c.set("a", { verdict: "safe", reason: "a", suggestion: "" });
		c.set("b", { verdict: "safe", reason: "b", suggestion: "" });
		c.get("a"); // 触达 a，b 变最旧
		c.set("c", { verdict: "safe", reason: "c", suggestion: "" });
		assert.equal(c.get("b"), undefined);
		assert.equal(c.get("a")?.reason, "a");
		assert.equal(c.get("c")?.reason, "c");
	});
	it("clear 清空", () => {
		const c = createReviewCache();
		c.set("a", { verdict: "safe", reason: "a", suggestion: "" });
		c.clear();
		assert.equal(c.get("a"), undefined);
	});
});

describe("formatReviewNote", () => {
	it("含结论与建议", () => {
		const note = formatReviewNote({ verdict: "risky", reason: "路径含通配符", suggestion: "先 ls 确认" });
		assert.ok(note.includes("有风险"));
		assert.ok(note.includes("路径含通配符"));
		assert.ok(note.includes("先 ls 确认"));
	});
	it("含 opinion 列表（单独成行，不加前缀）", () => {
		const note = formatReviewNote({
			verdict: "safe",
			reason: "ok",
			suggestion: "",
			opinion: "- 写法上动态拼接，建议下次显式列出路径",
		});
		assert.ok(note.includes("\n- 写法上动态拼接，建议下次显式列出路径"));
	});
	it("判可行且没有理由（模型只回了 [ok]）→ 把标记露出来，不显示成空", () => {
		const note = formatReviewNote({ verdict: "safe", reason: "", suggestion: "" });
		assert.ok(note.includes("[ok]"), note);
	});
	it("带风险档位 → 独立一行写档位（20 档写成 <20 字）", () => {
		const note = formatReviewNote({ verdict: "risky", reason: "通配符", suggestion: "", riskBudget: 20 });
		assert.ok(note.includes("风险档位：<20 字"), note);
		const big = formatReviewNote({ verdict: "dangerous", reason: "提权", suggestion: "", riskBudget: 60 });
		assert.ok(big.includes("风险档位：60 字"), big);
	});
	it("error 结论明确标示审核失败", () => {
		const note = formatReviewNote({
			verdict: "error",
			reason: "审核模型全部失败：ds-b：审核总时长超时（30000ms）",
			suggestion: "",
		});
		assert.ok(note.includes("审核失败"));
		assert.ok(note.includes("超时"));
		assert.ok(note.includes("30000ms"));
	});
});

describe("reviewCommand 失败拼装", () => {
	const makeCtx = (completeImpl: (modelId: string) => unknown) => {
		const models = new Map<string, { id: string }>();
		return {
			modelRegistry: {
				// 记录每个 provider/model 组合对应的 model id，方便按模型 id 返回不同响应
				find: (_p: string, m: string) => {
					const mm = { id: m };
					models.set(m, mm);
					return mm;
				},
				complete: async (model: { id: string }) => {
					const r = completeImpl(model.id);
					return { content: r, stopReason: "stop" } as unknown;
				},
				_models: models,
			},
			signal: undefined,
			model: undefined,
		} as any;
	};
	const text = (s: string) => ({ type: "text", text: s });
	const cache = createReviewCache(10);
	const config = {
		backend: "chat" as const,
		enabled: true,
		mode: "auto" as const,
		timeoutMs: 30000,
		tokenIdleMs: 4000,
		maxCache: 10,
		lowRiskAuto: true,
		lowRiskBudget: 40 as const,
		models: [
			{ provider: "zhipu", model: "glm-a" },
			{ provider: "deepseek", model: "ds-b" },
		],
	};

	it("模型回了自由文本（没按协议）：按字数落档判风险，不当失败", async () => {
		const ctx = makeCtx(() => [text("这条命令动态拼接路径，建议人工确认。")]);
		const r = await reviewCommand({} as any, ctx, "rm -rf x", [], undefined, cache, config);
		assert.equal(r.verdict, "risky");
		assert.equal(r.riskBudget, 20);
		assert.equal(r.reason, "这条命令动态拼接路径，建议人工确认。");
		// 协议漂了才需要原文留证
		assert.equal(r.opinion, "这条命令动态拼接路径，建议人工确认。");
	});

	it("多个模型都是空回复：判失败，每个模型独占一行（换行分隔）", async () => {
		const ctx = makeCtx(() => []);
		const r = await reviewCommand({} as any, ctx, "rm -rf x", [], undefined, createReviewCache(10), config);
		assert.equal(r.verdict, "error");
		assert.ok(r.reason.includes("模型没有输出任何内容"));
		// 换行分隔而非分号拼接：两个模型分布在 2 行（标题+模型1 同行，模型2 换行）
		assert.equal(r.reason.split("\n").length, 2);
		assert.ok(!r.reason.includes("；"));
		assert.ok(r.reason.split("\n")[1].includes("ds-b"));
	});
});

describe("buildClassifierReviewInput（分类器送审输入）", () => {
	it("缺省场景是 bash，事实层与命中规则原样带下去（bash 链行为不变）", () => {
		const input = buildClassifierReviewInput({
			command: "rm -rf /var/tmp/build",
			cwd: "/home/tester/proj",
			rules: [rule("rm -rf", ["rm", "-rf"]), rule("no-match")],
			userRequest: "清理构建残留",
			options: { factsUnavailable: "preshell 未安装" },
		});
		assert.equal(input.scenario, "bash");
		assert.equal(input.command, "rm -rf /var/tmp/build");
		assert.equal(input.cwd, "/home/tester/proj");
		assert.deepEqual(input.matchedRules, ["rm -rf", "no-match"]);
		assert.equal(input.userRequestExcerpt, "清理构建残留");
		assert.equal(input.preshellText, undefined);
		assert.equal(input.preshellUnavailable, "preshell 未安装");
	});

	it("PTC 脚本审核：scenario=ptc 送到分类器（否则它会多问一遭「是否脚本改写」）", () => {
		const input = buildClassifierReviewInput({
			command: "await bash('rm -rf /tmp/x')",
			cwd: "/home/tester/proj",
			rules: [],
			options: { scenario: "ptc" },
		});
		assert.equal(input.scenario, "ptc");
		assert.deepEqual(input.matchedRules, []);
		assert.equal(input.preshellText, undefined);
	});

	it("有 facts 时转成事实层文本（与审批窗同一口径）", () => {
		const facts = factsFromReport(
			{
				status: "Complete",
				impact: {
					effects: [{ kind: "Read", target: "/etc/hosts", modeled: true, line: 1 }],
					write_roots: [],
					uncertain: false,
					effects_dropped: 0,
					vars: [],
					cwd: "/tmp",
				},
				issues: [],
				issues_dropped: 0,
			},
			{ cwd: "/tmp" },
		);
		const input = buildClassifierReviewInput({
			command: "cat /etc/hosts",
			cwd: "/tmp",
			rules: [],
			options: { facts },
		});
		assert.ok(input.preshellText?.includes("/etc/hosts"), input.preshellText);
	});
});


describe("toAdvisorNote", () => {
	const r = (verdict: "safe" | "risky" | "dangerous" | "error", extra: Record<string, unknown> = {}) => ({
		verdict,
		reason: `${verdict} 的理由`,
		suggestion: verdict === "safe" ? "" : `${verdict} 的建议`,
		...extra,
	});

	it("原样带上 chat 的 verdict / reason / suggestion", () => {
		const note = toAdvisorNote(r("risky"), "risky");
		assert.equal(note?.verdict, "risky");
		assert.equal(note?.reason, "risky 的理由");
		assert.equal(note?.suggestion, "risky 的建议");
	});

	it("有 opinion 就带上", () => {
		const note = toAdvisorNote(r("risky", { opinion: "- 一条看法" }), "risky");
		assert.equal(note?.opinion, "- 一条看法");
	});

	it("风险档位跟着带过去（审批窗要显示）", () => {
		const note = toAdvisorNote(r("risky", { riskBudget: 60 }), "risky");
		assert.equal(note?.riskBudget, 60);
	});

	it("chat 失败时带 error 说明", () => {
		const note = toAdvisorNote({ verdict: "error", reason: "超时", suggestion: "" }, "risky");
		assert.equal(note?.error, "超时");
		assert.equal(note?.verdict, "error");
	});

	it("分类器放行但 chat 喊风险：留一行提醒（判决不变）", () => {
		const note = toAdvisorNote(r("risky"), "safe");
		assert.ok(note?.reason.startsWith("（分类器判放行，对话模型持异议）"));
		assert.ok(note?.reason.includes("risky 的理由"));
	});

	it("分类器放行 + chat 也放行：不加那句提醒", () => {
		const note = toAdvisorNote(r("safe"), "safe");
		assert.equal(note?.reason, "safe 的理由");
	});

	it("chat 失败时不加异议提醒（失败不等于喊风险）", () => {
		const note = toAdvisorNote({ verdict: "error", reason: "超时", suggestion: "" }, "safe");
		assert.ok(!note?.reason.includes("持异议"));
	});
});
