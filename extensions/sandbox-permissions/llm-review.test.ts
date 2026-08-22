// llm-review.test.ts — gate LLM 预审层纯函数测试
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/llm-review.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import {
	buildReviewPrompt,
	createReviewCache,
	formatReviewNote,
	normalizeConfig,
	parseVerdict,
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
	it("包含命令与命中规则", () => {
		const { system, user } = buildReviewPrompt("rm -rf /tmp/build", [rule("rm-recursive", ["-rf"])]);
		assert.ok(system.includes("bash 命令安全审核器"));
		assert.ok(system.includes("verdict"));
		assert.ok(user.includes("rm -rf /tmp/build"));
		assert.ok(user.includes("rm-recursive"));
		assert.ok(user.includes("-rf"));
	});
	it("无规则时给出动态构造提示", () => {
		const { user } = buildReviewPrompt("echo $(date)", []);
		assert.ok(user.includes("动态构造"));
	});
	it("超长命令截断", () => {
		const { user } = buildReviewPrompt("x".repeat(5000), []);
		assert.ok(user.includes("已截断"));
		assert.ok(user.length < 4600);
	});
});

describe("parseVerdict", () => {
	it("裸 JSON", () => {
		const r = parseVerdict('{"verdict":"safe","reason":"ok","suggestion":""}');
		assert.deepEqual(r, { verdict: "safe", reason: "ok", suggestion: "" });
	});
	it("markdown 代码块包裹", () => {
		const r = parseVerdict('```json\n{"verdict":"risky","reason":"路径含通配符","suggestion":"先 ls 确认"}\n```');
		assert.equal(r.verdict, "risky");
		assert.equal(r.reason, "路径含通配符");
		assert.equal(r.suggestion, "先 ls 确认");
	});
	it("前后缀噪音", () => {
		const r = parseVerdict('好的，审核如下：\n{"verdict":"dangerous","reason":"删除系统目录","suggestion":""}\n以上。');
		assert.equal(r.verdict, "dangerous");
	});
	it("空/纯文本 → error", () => {
		assert.equal(parseVerdict("").verdict, "error");
		assert.equal(parseVerdict("   ").verdict, "error");
		assert.equal(parseVerdict("抱歉我无法判断").verdict, "error");
	});
	it("非法 JSON → error", () => {
		assert.equal(parseVerdict("{not json}").verdict, "error");
	});
	it("verdict 非法值 → error", () => {
		assert.equal(parseVerdict('{"verdict":"maybe","reason":"x","suggestion":""}').verdict, "error");
		assert.equal(parseVerdict('{"reason":"缺 verdict"}').verdict, "error");
	});
	it("reason/suggestion 非字符串容错为空", () => {
		const r = parseVerdict('{"verdict":"safe","reason":123,"suggestion":null}');
		assert.deepEqual(r, { verdict: "safe", reason: "", suggestion: "" });
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
});
