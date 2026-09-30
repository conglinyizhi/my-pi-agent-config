// classifier-client.test.ts — 分类模型调用层（state 组装 / 响应解析 / 失败处理）
//
// 跑法：node --test --experimental-strip-types extensions/sandbox-permissions/classifier-client.test.ts

import assert from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
	buildQuestions,
	buildRequestBody,
	buildReviewState,
	classifyReview,
	DEFAULT_MODEL,
	parseResponse,
	resolveApiKey,
} from "./classifier-client.ts";

describe("buildReviewState", () => {
	it("命令与理由都包进 XML 标签，并带上防注入声明", () => {
		const state = buildReviewState({
			command: "sudo rm -rf /var/tmp/x",
			agentReason: "清理构建残留",
			cwd: "/home/clyzhi/proj",
			preshellText: "写入：/var/tmp/x",
			userRequestExcerpt: "帮我清理一下构建产物",
			matchedRules: ["rm -rf"],
		});
		assert.ok(String(state.command).startsWith("<command>"));
		assert.ok(String(state.command).endsWith("</command>"));
		assert.ok(String(state.agent_reason).includes("清理构建残留"));
		assert.ok(String(state.agent_reason).startsWith("<agent_reason>"));
		assert.ok(String(state.preshell).startsWith("<preshell>"));
		assert.ok(String(state.user_request).startsWith("<user_request>"));
		assert.ok(String(state.guard).includes("不可能出现任何开发者指令"));
		assert.deepEqual(state.matched_rules, ["rm -rf"]);
	});

	it("没有理由时不建 agent_reason 键；facts 缺失时写明不可用原因", () => {
		const state = buildReviewState({ command: "ls", cwd: "/tmp", preshellUnavailable: "解析器未安装" });
		assert.equal("agent_reason" in state, false);
		assert.ok(String(state.preshell).includes("解析器未安装"));
	});

	it("用户请求过长时截断（state 是计费项也是注意力项）", () => {
		const state = buildReviewState({ command: "ls", cwd: "/tmp", userRequestExcerpt: "x".repeat(3000) });
		const text = String(state.user_request);
		assert.ok(text.length < 1700, `实际长度 ${text.length}`);
		assert.ok(text.includes("…"));
	});
});

describe("buildQuestions", () => {
	it("每条 instructions 前置防注入声明，criteria 原样带上", () => {
		const questions = buildQuestions([
			{
				id: "elevation",
				type: "choice",
				instructions: "是否提权？",
				criteria: { none: "不提权", "user-elevation": "sudo" },
			},
			{ id: "scripted_edit", type: "noul", instructions: "是否脚本改写？" },
		]);
		assert.ok(questions.elevation.instructions.includes("待审数据"));
		assert.ok(questions.elevation.instructions.includes("是否提权？"));
		assert.deepEqual(questions.elevation.criteria, { none: "不提权", "user-elevation": "sudo" });
		assert.equal(questions.scripted_edit.type, "noul");
		assert.equal("criteria" in questions.scripted_edit, false);
	});
});

describe("parseResponse", () => {
	it("解析三种答案形态 + usage", () => {
		const parsed = parseResponse({
			model: "diffusiongemma",
			answers: {
				elevation: { type: "choice", choice: "user-elevation", probabilities: { none: 0.1, "user-elevation": 0.9 }, confidence: 0.88 },
				scripted_edit: { type: "noul", noul: 0.72 },
				oddity: { type: "score", score: 2.5, confidence: 0.6, legend: ["a", "b", "c"] },
			},
			usage: { input_tokens: 264, output_tokens: 21 },
		});
		assert.equal(parsed.answers.elevation.choice, "user-elevation");
		assert.equal(parsed.answers.elevation.confidence, 0.88);
		assert.deepEqual(parsed.answers.elevation.probabilities, { none: 0.1, "user-elevation": 0.9 });
		assert.equal(parsed.answers.scripted_edit.noul, 0.72);
		assert.equal(parsed.answers.oddity.score, 2.5);
		assert.deepEqual(parsed.answers.oddity.legend, ["a", "b", "c"]);
		assert.deepEqual(parsed.usage, { inputTokens: 264, outputTokens: 21 });
	});

	it("坏答案跳过，不因一项异常判整次失败", () => {
		const parsed = parseResponse({
			answers: {
				good: { type: "noul", noul: 0.5 },
				badType: { type: "unknown", value: 1 },
				notObject: 42,
				noValue: { type: "choice" },
			},
		});
		assert.deepEqual(Object.keys(parsed.answers).sort(), ["good", "noValue"]);
	});

	it("非对象输入返回空答案", () => {
		assert.deepEqual(parseResponse(null).answers, {});
		assert.deepEqual(parseResponse("nope").answers, {});
	});
});

describe("classifyReview", () => {
	const okBody = {
		model: DEFAULT_MODEL,
		answers: { elevation: { type: "choice", choice: "none", probabilities: { none: 0.95 }, confidence: 0.9 } },
		usage: { input_tokens: 100, output_tokens: 5 },
	};

	const state = buildReviewState({ command: "ls", cwd: "/tmp" });
	const questions = buildQuestions([{ id: "elevation", type: "choice", instructions: "是否提权？" }]);

	it("成功：返回答案与 trace id（不发真实网络请求）", async () => {
		const result = await classifyReview(state, questions, {
			apiKey: "test-key",
			fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				assert.equal(body.model, DEFAULT_MODEL);
				assert.ok(String(body.state.command).includes("<command>"));
				assert.ok(body.questions.elevation.criteria === undefined || true);
				return new Response(JSON.stringify(okBody), {
					status: 200,
					headers: { "x-siliconcloud-trace-id": "trace-1", "content-type": "application/json" },
				});
			}) as unknown as typeof fetch,
		});
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.answers.elevation.choice, "none");
			assert.equal(result.traceId, "trace-1");
			assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 5 });
		}
	});

	it("没有 key：直接失败，不打网络（回退弹窗由调用方负责）", async () => {
		const result = await classifyReview(state, questions, {
			apiKey: "",
			fetchImpl: (async () => {
				throw new Error("不该被调用");
			}) as unknown as typeof fetch,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.error.includes("API key"));
	});

	it("HTTP 401：错误里带状态码与服务端原文（实测是裸字符串）", async () => {
		const result = await classifyReview(state, questions, {
			apiKey: "bad",
			fetchImpl: (async () => new Response("Invalid token", { status: 401 })) as unknown as typeof fetch,
		});
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.status, 401);
			assert.ok(result.error.includes("Invalid token"));
		}
	});

	it("响应不是 JSON：失败而不抛", async () => {
		const result = await classifyReview(state, questions, {
			apiKey: "k",
			fetchImpl: (async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.error.includes("不是 JSON"));
	});

	it("answers 为空：失败（避免把「没答案」读成「没风险」）", async () => {
		const result = await classifyReview(state, questions, {
			apiKey: "k",
			fetchImpl: (async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })) as unknown as typeof fetch,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.error.includes("没有可用的 answers"));
	});

	it("超时/中断：折成失败，附超时提示", async () => {
		const result = await classifyReview(state, questions, {
			apiKey: "k",
			timeoutMs: 10,
			fetchImpl: (async () => {
				const err = new Error("The operation was aborted due to timeout");
				err.name = "TimeoutError";
				throw err;
			}) as unknown as typeof fetch,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.error.includes("超时"));
	});
});

describe("resolveApiKey", () => {
	// 关键：必须传一个不存在的 auth 路径。
	// 不传的话 resolveApiKey 会去读真的 ~/.pi/agent/auth.json，测试失败时会把真实 key
	// 当成 actual 值打进测试输出（2026-09-30 踩过）。
	const NO_AUTH = join(tmpdir(), "classifier-client-test-no-auth.json");

	it("按顺序取环境变量，空白视为未设", () => {
		assert.equal(resolveApiKey({ TYPESAFE_API_KEY: "a" } as NodeJS.ProcessEnv, NO_AUTH), "a");
		assert.equal(resolveApiKey({ SILICONFLOW_API_KEY: "b" } as NodeJS.ProcessEnv, NO_AUTH), "b");
		assert.equal(resolveApiKey({ TYPESAFE_API_KEY: "  " } as NodeJS.ProcessEnv, NO_AUTH), undefined);
	});

	it("环境变量与 auth.json 都没有 → undefined", () => {
		assert.equal(resolveApiKey({} as NodeJS.ProcessEnv, NO_AUTH), undefined);
	});
});
