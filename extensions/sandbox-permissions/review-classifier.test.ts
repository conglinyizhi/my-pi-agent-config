// review-classifier.test.ts — 分类审核后端的集成链路（mock 服务端，不发真实请求）
//
// 跑法：node --test --experimental-strip-types extensions/sandbox-permissions/review-classifier.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { defaultClassifierConfig, formatHitReason, normalizeDimensions, reviewViaClassifier } from "./review-classifier.ts";
import { evaluateAll, synthesize, type RawAnswer } from "./review-dimensions.ts";

const BASE_INPUT = {
	command: "sudo rm -rf /var/tmp/build",
	cwd: "/home/clyzhi/proj",
	preshellText: "写入：/var/tmp/build",
	agentReason: "清理构建残留",
	matchedRules: ["rm -rf"],
};

/** 造一个服务端响应：所有维度都给「低风险 + 高置信」 */
function calmAnswers() {
	return {
		elevation: { type: "choice", choice: "none", probabilities: { none: 0.96, "user-elevation": 0.03, "privileged-change": 0.01 }, confidence: 0.95 },
		network: { type: "choice", choice: "none", probabilities: { none: 0.97, "fetch-only": 0.02, upload: 0.01 }, confidence: 0.94 },
		intent: { type: "choice", choice: "explicitly-requested", probabilities: { "explicitly-requested": 0.9, "necessary-step": 0.07, inferable: 0.02, unrelated: 0.01 }, confidence: 0.9 },
		secret_exposure: { type: "choice", choice: "none", probabilities: { none: 0.95, "local-read": 0.04, "possible-egress": 0.01 }, confidence: 0.92 },
		wallet_access: { type: "choice", choice: "none", probabilities: { none: 0.99, "wallet-adjacent": 0.01, "direct-key-access": 0 }, confidence: 0.98 },
		scripted_edit: { type: "noul", noul: 0.05 },
		preshell_trust: { type: "choice", choice: "trustworthy", probabilities: { trustworthy: 0.9, "blind-spots": 0.08, opaque: 0.02 }, confidence: 0.88 },
		oddity: { type: "score", score: 0.5, confidence: 0.8 },
	};
}

function resp(body: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

describe("reviewViaClassifier", () => {
	const config = { ...defaultClassifierConfig(), apiKey: "test-key" };

	it("各维度都不超阈值 → safe（放行，不打扰用户）", async () => {
		const result = await reviewViaClassifier(BASE_INPUT, config, {
			classifyOptions: { fetchImpl: (async () => resp({ answers: calmAnswers() })) as unknown as typeof fetch },
		});
		assert.equal(result.verdict, "safe");
		assert.ok(result.reason.includes("8 个维度"));
		assert.equal(result.suggestion, "");
		// safe 分支也带权重表（strict 模式同样弹窗；出问题时最该看当时的数）
		assert.equal(result.dimensions?.length, 8);
		assert.equal(result.dimensions?.every((d) => d.triggered === false), true);
	});

	it("提权维度触发 → risky，理由里点名维度与数字（没有 block 出口）", async () => {
		const answers = { ...calmAnswers() };
		answers.elevation = { type: "choice", choice: "privileged-change", probabilities: { none: 0.05, "user-elevation": 0.15, "privileged-change": 0.8 }, confidence: 0.9 };
		const result = await reviewViaClassifier(BASE_INPUT, config, {
			classifyOptions: { fetchImpl: (async () => resp({ answers })) as unknown as typeof fetch },
		});
		assert.equal(result.verdict, "risky");
		assert.ok(result.reason.includes("提权"));
		assert.ok(result.reason.includes("0.95")); // 0.15 + 0.8
		assert.ok(!["dangerous", "blocked"].includes(result.verdict));
		// 权重表：按风险降序，提权在最前，且带上概率（本机自用，不脱敏）
		assert.equal(result.dimensions?.[0].id, "elevation");
		assert.equal(result.dimensions?.[0].triggered, true);
		assert.ok(result.dimensions?.[0].probabilities?.["privileged-change"] === 0.8);
	});

	it("置信度低于 below → 也触发（模型没把握时宁可信其有）", async () => {
		const answers = { ...calmAnswers() };
		// 风险值低（高风险档合计 0.2），但 confidence 0.2 < 0.5
		answers.intent = { type: "choice", choice: "necessary-step", probabilities: { "explicitly-requested": 0.4, "necessary-step": 0.4, inferable: 0.1, unrelated: 0.1 }, confidence: 0.2 };
		const result = await reviewViaClassifier(BASE_INPUT, config, {
			classifyOptions: { fetchImpl: (async () => resp({ answers })) as unknown as typeof fetch },
		});
		assert.equal(result.verdict, "risky");
		assert.ok(result.reason.includes("符合意图"));
		assert.ok(result.reason.includes("置信度"));
	});

	it("整体可疑（oddity）高分 → risky，理由里带档位文字", async () => {
		const answers = { ...calmAnswers() };
		answers.oddity = { type: "score", score: 4, confidence: 0.85 };
		const result = await reviewViaClassifier(BASE_INPUT, config, {
			classifyOptions: { fetchImpl: (async () => resp({ answers })) as unknown as typeof fetch },
		});
		assert.equal(result.verdict, "risky");
		assert.ok(result.reason.includes("整体可疑"));
		assert.ok(result.reason.includes("强烈可疑"));
	});

	it("服务端失败 → error（调用方据此回退弹窗，不静默放行）", async () => {
		const result = await reviewViaClassifier(BASE_INPUT, config, {
			classifyOptions: { fetchImpl: (async () => new Response("Invalid token", { status: 401 })) as unknown as typeof fetch },
		});
		assert.equal(result.verdict, "error");
		assert.ok(result.reason.includes("401"));
		// 失败时没拿到答案：不编造空表，让前端按“无权重”处理
		assert.equal(result.dimensions, undefined);
	});

	it("维度全禁用 → error（而不是 safe）", async () => {
		const disabled = {
			...config,
			dimensions: config.dimensions.map((d) => ({ ...d, enabled: false })),
		};
		const result = await reviewViaClassifier(BASE_INPUT, disabled, {
			classifyOptions: { fetchImpl: (async () => resp({ answers: calmAnswers() })) as unknown as typeof fetch },
		});
		assert.equal(result.verdict, "error");
		assert.ok(result.reason.includes("禁用"));
	});

	it("请求体里命令被 XML 包裹，且带防注入声明", async () => {
		let seen: Record<string, unknown> | undefined;
		await reviewViaClassifier(BASE_INPUT, config, {
			classifyOptions: {
				fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
					seen = JSON.parse(String(init?.body));
					return resp({ answers: calmAnswers() });
				}) as unknown as typeof fetch,
			},
		});
		const state = seen?.state as Record<string, unknown>;
		const questions = seen?.questions as Record<string, { instructions: string }>;
		assert.ok(String(state.command).includes("<command>"));
		assert.ok(String(state.agent_reason).includes("清理构建残留"));
		assert.equal(seen?.model, "diffusiongemma");
		assert.equal(Object.keys(questions).length, 8);
		assert.ok(questions.elevation.instructions.includes("待审数据"));
	});
});

describe("场景：PTC 脚本审核（scripted_edit 不启用）", () => {
	const config = { ...defaultClassifierConfig(), apiKey: "test-key" };
	const PTC_INPUT = { ...BASE_INPUT, scenario: "ptc" as const };

	it("scripted_edit 不进分类器请求，其余七维照问", async () => {
		let seen: Record<string, unknown> | undefined;
		await reviewViaClassifier(PTC_INPUT, config, {
			classifyOptions: {
				fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
					seen = JSON.parse(String(init?.body));
					return resp({ answers: calmAnswers() });
				}) as unknown as typeof fetch,
			},
		});
		const questions = seen?.questions as Record<string, unknown>;
		assert.equal(Object.keys(questions).length, 7);
		assert.equal("scripted_edit" in questions, false);
		assert.ok("oddity" in questions);
		assert.ok("preshell_trust" in questions);
	});

	it("服务端即使多回一个 scripted_edit 高风险答案，也不计入判定", async () => {
		const answers = { ...calmAnswers(), scripted_edit: { type: "noul", noul: 0.99 } };
		const result = await reviewViaClassifier(PTC_INPUT, config, {
			classifyOptions: { fetchImpl: (async () => resp({ answers })) as unknown as typeof fetch },
		});
		// 该维度没问过：不能用它的概率把 verdict 拉成 risky
		assert.equal(result.verdict, "safe");
		assert.ok(result.reason.includes("7 个维度"), result.reason);
	});

	it("负载里带禁用标记：行附在末尾，说明指向 PTC 场景", async () => {
		const answers = { ...calmAnswers() };
		answers.elevation = { type: "choice", choice: "privileged-change", probabilities: { none: 0.05, "user-elevation": 0.15, "privileged-change": 0.8 }, confidence: 0.9 };
		const result = await reviewViaClassifier(PTC_INPUT, config, {
			classifyOptions: { fetchImpl: (async () => resp({ answers })) as unknown as typeof fetch },
		});
		assert.equal(result.verdict, "risky");
		// 提问过的七维照旧参与（提权在最前，按风险降序）
		assert.equal(result.dimensions?.filter((d) => !d.disabled).length, 7);
		assert.equal(result.dimensions?.[0].id, "elevation");
		const last = result.dimensions?.[result.dimensions.length - 1];
		assert.equal(last?.id, "scripted_edit");
		assert.equal(last?.disabled, true);
		assert.ok(last?.disabledNote?.includes("PTC"), last?.disabledNote);
		// 没问过就不谎报触发（否则前端会把它当越线行标底色）
		assert.equal(last?.triggered, false);
		assert.equal(last?.reason, "");
	});

	it("bash 场景（缺省）与现有行为一致：八维全问、没有禁用行", async () => {
		let seen: Record<string, unknown> | undefined;
		const result = await reviewViaClassifier(BASE_INPUT, config, {
			classifyOptions: {
				fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
					seen = JSON.parse(String(init?.body));
					return resp({ answers: calmAnswers() });
				}) as unknown as typeof fetch,
			},
		});
		assert.equal(Object.keys(seen?.questions as Record<string, unknown>).length, 8);
		assert.equal(result.verdict, "safe");
		assert.equal(result.dimensions?.length, 8);
		assert.equal(result.dimensions?.some((d) => d.disabled === true), false);
	});

	it("PTC 场景下所有维度都被配置关掉 → 仍是 error（不静默放行）", async () => {
		const disabled = {
			...config,
			dimensions: config.dimensions.map((d) => ({ ...d, enabled: false })),
		};
		const result = await reviewViaClassifier(PTC_INPUT, disabled, {
			classifyOptions: { fetchImpl: (async () => resp({ answers: calmAnswers() })) as unknown as typeof fetch },
		});
		assert.equal(result.verdict, "error");
	});
});

describe("normalizeDimensions", () => {
	it("缺失配置 → 默认八项（0.5 / review）", () => {
		const dims = normalizeDimensions(undefined);
		assert.equal(dims.length, 8);
		for (const d of dims) {
			assert.equal(d.above, 0.5);
			assert.equal(d.action, "review");
		}
	});

	it("用户改过的项生效，未提到的项保持默认；顺序稳定", () => {
		const dims = normalizeDimensions([
			{ id: "oddity", above: 0.2, action: "ignore" },
			{ id: "network", below: 0.8 },
		]);
		assert.deepEqual(dims.map((d) => d.id), [
			"elevation",
			"network",
			"intent",
			"secret_exposure",
			"wallet_access",
			"scripted_edit",
			"preshell_trust",
			"oddity",
		]);
		assert.equal(dims.find((d) => d.id === "oddity")?.above, 0.2);
		assert.equal(dims.find((d) => d.id === "oddity")?.action, "ignore");
		assert.equal(dims.find((d) => d.id === "network")?.below, 0.8);
		assert.equal(dims.find((d) => d.id === "elevation")?.above, 0.5);
	});

	it("noul 维度的 below 永远为 null（配置里写了也不采纳）", () => {
		const dims = normalizeDimensions([{ id: "scripted_edit", below: 0.9 }]);
		assert.equal(dims.find((d) => d.id === "scripted_edit")?.below, null);
	});

	it("未知 id 被忽略", () => {
		const dims = normalizeDimensions([{ id: "no-such-dimension", above: 0.1 }]);
		assert.equal(dims.length, 8);
	});
});

describe("formatHitReason", () => {
	it("逐条列出命中维度，便于人工核对", () => {
		const answers: Record<string, RawAnswer> = {
			elevation: { type: "choice", choice: "user-elevation", probabilities: { none: 0.1, "user-elevation": 0.9, "privileged-change": 0 }, confidence: 0.9 },
		};
		const verdicts = evaluateAll(answers, defaultClassifierConfig().dimensions);
		const text = formatHitReason(synthesize(verdicts).hit);
		assert.ok(text.startsWith("提权："));
		assert.ok(text.includes("0.90"));
	});
});
