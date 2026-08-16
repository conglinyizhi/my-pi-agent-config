// registry.test.ts — lib/prompt-sections.ts 注册表/装配/渲染语义测试
//
// 覆盖（DSH system-prompt 语义逐条对照）：
//   1. order 升序拼接 + 空段丢弃 + 空行分隔
//   2. 隐式 pi:default 段（order 0）+ 同名注册遮蔽（persona 替换）
//   3. 严格变量插值：已注册 undefined 抛错；未注册引用保留字面量；替换值不再二次扫描
//   4. complete 段：恰一个 → 唯一提示词；多个 → 抛错；空 complete 段不算
//   5. 同名遮蔽 + disposer 身份语义（旧 disposer 失效、新 disposer 移除当前）
//   6. 非法变量名抛错
//
// 跑法：node --experimental-strip-types extensions/prompt-sections/registry.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_SECTION_NAME,
	PromptVariableError,
	type AssembleContext,
	assemble,
	getSections,
	interpolate,
	registerSection,
	registerVariable,
	renderPrompt,
	resetRegistry,
} from "../../lib/prompt-sections.ts";

function baseCtx(overrides: Partial<AssembleContext> = {}): AssembleContext {
	return {
		cwd: "/tmp/workspace",
		model: "deepseek-v4-flash",
		date: "2026-08-15",
		time: "10:00",
		prompt: "do the thing",
		defaultSystemPrompt: "[DEFAULT PROMPT]\nCurrent working directory: /tmp/workspace",
		...overrides,
	};
}

describe("prompt-sections registry", () => {
	it("按 order 升序拼接，空段丢弃，空行分隔", async () => {
		resetRegistry();
		registerSection({ name: "s:later", order: 200, text: "LATER" });
		registerSection({ name: "s:identity", order: -100, text: "IDENTITY" });
		registerSection({ name: "s:empty", order: 50, text: "" });
		registerSection({ name: "s:policy", order: 50, text: "  POLICY  " });

		const assembly = await assemble(baseCtx());
		const prompt = renderPrompt(assembly);

		assert.equal(
			prompt,
			"IDENTITY\n\n[DEFAULT PROMPT]\nCurrent working directory: /tmp/workspace\n\nPOLICY\n\nLATER",
		);
		assert.deepEqual(
			assembly.sections.map((s) => s.name),
			["s:identity", DEFAULT_SECTION_NAME, "s:policy", "s:later"],
		);
	});

	it("同名注册遮蔽：新注册替换旧注册，旧 disposer 失效", async () => {
		resetRegistry();
		const disposeOld = registerSection({ name: "dup", order: 10, text: "OLD" });
		registerSection({ name: "dup", order: 10, text: "NEW" });

		let prompt = renderPrompt(await assemble(baseCtx()));
		assert.ok(prompt.includes("NEW"));
		assert.ok(!prompt.includes("OLD"));

		// 旧 disposer 不生效（它已不是当前注册）
		disposeOld();
		prompt = renderPrompt(await assemble(baseCtx()));
		assert.ok(prompt.includes("NEW"));
	});

	it("disposer 移除当前注册", async () => {
		resetRegistry();
		const dispose = registerSection({ name: "tmp", order: 5, text: "TMP" });
		dispose();
		const prompt = renderPrompt(await assemble(baseCtx()));
		assert.ok(!prompt.includes("TMP"));
	});

	it("隐式 pi:default 可被同名注册遮蔽（persona 替换）", async () => {
		resetRegistry();
		registerSection({ name: DEFAULT_SECTION_NAME, order: 0, text: "PERSONA REPLACEMENT" });
		const prompt = renderPrompt(await assemble(baseCtx()));
		assert.equal(prompt, "PERSONA REPLACEMENT");
		assert.ok(!prompt.includes("DEFAULT PROMPT"));
	});

	it("严格变量：已注册 undefined 抛 PromptVariableError", async () => {
		resetRegistry();
		registerSection({ name: "s", order: 10, text: "模型是 {{model}}，缺失是 {{missing}}" });
		registerVariable("model", () => "grok-4.5");
		registerVariable("missing", () => undefined);
		const assembly = await assemble(baseCtx());
		assert.throws(() => renderPrompt(assembly), PromptVariableError);
	});

	it("未注册引用保留字面量（pi 链兼容：skill-kit 等下游替换）", async () => {
		resetRegistry();
		registerSection({ name: "s", order: 10, text: "读 {{PI_README_PATH}}" });
		const prompt = renderPrompt(await assemble(baseCtx()));
		assert.ok(prompt.endsWith("\n\n读 {{PI_README_PATH}}"));
	});

	it("替换后的值不再二次扫描（DSH 语义）", async () => {
		resetRegistry();
		registerSection({ name: "s", order: 10, text: "值={{v}}" });
		registerVariable("v", () => "{{model}}");
		const prompt = renderPrompt(await assemble(baseCtx()));
		assert.ok(prompt.endsWith("\n\n值={{model}}"));
	});

	it("complete 段：恰一个 → 唯一提示词（仍解析变量）", async () => {
		resetRegistry();
		registerVariable("model", () => "deepseek-v4-flash");
		registerSection({ name: "identity", order: -100, text: "IDENTITY" });
		registerSection({ name: "complete", order: 50, text: "COMPLETE {{model}}", complete: true });
		const prompt = renderPrompt(await assemble(baseCtx()));
		assert.equal(prompt, "COMPLETE deepseek-v4-flash");
	});

	it("多个有效 complete 段抛错；空 complete 段不算", async () => {
		resetRegistry();
		registerSection({ name: "a", order: 1, text: "A", complete: true });
		registerSection({ name: "b", order: 2, text: "B", complete: true });
		await assert.rejects(assemble(baseCtx()), /多个有效 complete 段/);

		resetRegistry();
		registerSection({ name: "a", order: 1, text: "", complete: true });
		registerSection({ name: "b", order: 2, text: "B", complete: false });
		const prompt = renderPrompt(await assemble(baseCtx()));
		assert.ok(prompt.includes("B"));
	});

	it("非法变量名抛错；合法名通过", async () => {
		resetRegistry();
		assert.throws(() => registerVariable("Bad-Name", () => "x"), /非法变量名/);
		registerVariable("ok_name1", () => "x");
		assert.deepEqual(Object.keys(getSections()), []);
	});

	it("变量提供方按次求值（动态内容）", async () => {
		resetRegistry();
		let tick = 0;
		registerSection({ name: "s", order: 10, text: "tick={{t}}" });
		registerVariable("t", () => String(++tick));
		const expected = (n: number) =>
			`[DEFAULT PROMPT]\nCurrent working directory: /tmp/workspace\n\ntick=${n}`;
		assert.equal(renderPrompt(await assemble(baseCtx())), expected(1));
		assert.equal(renderPrompt(await assemble(baseCtx())), expected(2));
	});

	it("interpolate 独立可用：孤立 {{ 视为散文保留", async () => {
		const out = interpolate("成本 {{ 和 {{ok}}", { ok: "OK" });
		assert.equal(out, "成本 {{ 和 OK");
	});
});
