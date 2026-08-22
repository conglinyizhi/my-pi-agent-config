// llm-review.test.ts — gate LLM 预审层纯函数测试
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/llm-review.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import {
	buildReviewPrompt,
	createReviewCache,
	extractReviewResult,
	formatReviewNote,
	normalizeConfig,
	REVIEW_TOOL,
	reviewCacheKey,
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
		assert.equal(c.timeoutMs, 10_000);
		assert.equal(c.maxCache, 200);
	});
	it("覆盖已知字段（toml 下划线风格）、忽略未知字段", () => {
		const c = normalizeConfig({
			enabled: false,
			mode: "strict",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			timeout_ms: 5000,
			max_cache: 50,
			bogus: 1,
		});
		assert.equal(c.enabled, false);
		assert.equal(c.mode, "strict");
		assert.equal(c.provider, "deepseek");
		assert.equal(c.model, "deepseek-v4-flash");
		assert.equal(c.timeoutMs, 5000);
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
		assert.equal(c.timeoutMs, 10_000);
		assert.equal(c.maxCache, 200);
	});
	it("真实 toml 文本解析后 normalize 生效", () => {
		const doc = parseToml(`
[sandbox-llm-review]
enabled = true
mode = "auto"
timeout_ms = 8000
max_cache = 50
`) as Record<string, unknown>;
		const c = normalizeConfig(doc["sandbox-llm-review"]);
		assert.equal(c.enabled, true);
		assert.equal(c.mode, "auto");
		assert.equal(c.timeoutMs, 8000);
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
});

describe("extractReviewResult", () => {
	const toolCall = (args: Record<string, unknown>) => ({
		type: "toolCall" as const,
		id: "call_1",
		name: REVIEW_TOOL.name,
		arguments: args,
	});
	const text = (t: string) => ({ type: "text" as const, text: t });

	it("优先取工具调用参数，工具调用后的文本收集为 opinion", () => {
		const r = extractReviewResult([
			text("命令拼接方式有隐患，建议人工确认后再执行。"),
			toolCall({ verdict: "risky", reason: "路径含通配符", suggestion: "先 ls 确认" }),
		]);
		assert.deepEqual(r, {
			verdict: "risky",
			reason: "路径含通配符",
			suggestion: "先 ls 确认",
			opinion: "命令拼接方式有隐患，建议人工确认后再执行。",
		});
	});
	it("工具调用无自由文本 → 不带 opinion 字段", () => {
		const r = extractReviewResult([
			toolCall({ verdict: "safe", reason: 123, suggestion: null }),
		]);
		assert.deepEqual(r, { verdict: "safe", reason: "", suggestion: "" });
		assert.equal("opinion" in r, false);
	});
	it("opinion 超长截断到 500 字符", () => {
		const r = extractReviewResult([
			text("x".repeat(600)),
			toolCall({ verdict: "safe", reason: "ok", suggestion: "" }),
		]);
		assert.equal(r.opinion?.length, 500);
	});
	it("工具调用 verdict 非法值 → error", () => {
		const r = extractReviewResult([toolCall({ verdict: "maybe", reason: "x", suggestion: "" })]);
		assert.equal(r.verdict, "error");
	});
	it("未调用工具时：文本原样作为 opinion，verdict=error（不解析 JSON）", () => {
		const r = extractReviewResult([
			text("这条命令用了变量拼接路径，我判断存在注入风险，建议人工确认。"),
		]);
		assert.equal(r.verdict, "error");
		assert.equal(r.reason, "模型未给出结构化结论（未调用审核工具）");
		assert.equal(r.opinion, "这条命令用了变量拼接路径，我判断存在注入风险，建议人工确认。");
	});
	it("未调用工具且无文本 → error，不带 opinion", () => {
		const r = extractReviewResult([]);
		assert.equal(r.verdict, "error");
		assert.equal("opinion" in r, false);
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
	it("含 opinion 看法", () => {
		const note = formatReviewNote({
			verdict: "safe",
			reason: "ok",
			suggestion: "",
			opinion: "写法上动态拼接，建议下次显式列出路径",
		});
		assert.ok(note.includes("看法"));
		assert.ok(note.includes("建议下次显式列出路径"));
	});
});
