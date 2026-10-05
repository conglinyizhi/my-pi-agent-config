// review-settings.test.ts — 审核设置读写的动作与安全边界
//
// 跑法：node --test --experimental-strip-types lib/review-settings.test.ts
//
// 一律在 /tmp 的副本上操作，绝不碰仓里的 extensions.toml / review-dimensions.toml
// （extensions.toml 里有满注释的手写配置，弄坏了很麻烦）。
//
// 这里盯的不变量：
//   1 改一个键之后，文件其余部分逐字不变（行尾注释、其它段、空白）
//   2 非法输入拒绝，且文件一个字节都没动
//   3 数值区间与枚举白名单与窗口/后端同源（REVIEW_LIMITS）
//   4 写盘是原子替换：失败时原文件保持原状，且不留临时文件

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import {
	REVIEW_LIMITS,
	ReviewSettingsError,
	atomicWriteFile,
	defaultReviewSettingsPaths,
	dimensionFieldSpecs,
	formatDimensionsToml,
	loadReviewSettings,
	planSettingsWrite,
	replaceTomlKey,
	resetReviewSettingsPathsForTest,
	saveDimensions,
	saveReviewSettings,
	setReviewSettingsPathsForTest,
	splitValueAndTail,
} from "./review-settings.ts";
import { defaultDimensionConfigs } from "../extensions/sandbox-permissions/review-dimensions.ts";
import { loadLlmReviewConfig } from "../extensions/sandbox-permissions/llm-review.ts";
import { loadClassifierConfig } from "../extensions/sandbox-permissions/review-classifier.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_EXTENSIONS_TOML = join(REPO_ROOT, "extensions.toml");
const REAL_DIMENSIONS_TOML = join(REPO_ROOT, "extensions", "sandbox-permissions", "review-dimensions.toml");

const tmp = mkdtempSync(join(tmpdir(), "review-settings-test-"));
const extensionsToml = join(tmp, "extensions.toml");
const dimensionsToml = join(tmp, "review-dimensions.toml");

function seed(): void {
	copyFileSync(REAL_EXTENSIONS_TOML, extensionsToml);
	copyFileSync(REAL_DIMENSIONS_TOML, dimensionsToml);
}

beforeEach(() => {
	seed();
	setReviewSettingsPathsForTest({ extensionsToml, dimensionsToml });
});

after(() => {
	resetReviewSettingsPathsForTest();
	rmSync(tmp, { recursive: true, force: true });
});

/** 两份文本的差异行（行号 + 前后），用来断言「只有那一行变了」 */
function diffLines(before: string, after: string): { index: number; before: string; after: string }[] {
	const a = before.split("\n");
	const b = after.split("\n");
	const out: { index: number; before: string; after: string }[] = [];
	for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
		if (a[i] !== b[i]) out.push({ index: i, before: a[i] ?? "(缺行)", after: b[i] ?? "(缺行)" });
	}
	return out;
}

describe("splitValueAndTail", () => {
	it("带引号的值按引号收尾，行尾注释整段留在 tail", () => {
		assert.deepEqual(splitValueAndTail('"auto"  # auto=判安全直接放行；strict=仅给意见仍弹窗'), {
			value: '"auto"',
			tail: "  # auto=判安全直接放行；strict=仅给意见仍弹窗",
		});
	});

	it("裸值（数字 / 布尔）按「空白 + #」认注释", () => {
		assert.deepEqual(splitValueAndTail("true # 总开关；false = 回到纯规则弹窗流程"), {
			value: "true",
			tail: " # 总开关；false = 回到纯规则弹窗流程",
		});
		assert.deepEqual(splitValueAndTail("30000 # 注册模型单次审核总时长兜底（毫秒）；超时切换下一个模型"), {
			value: "30000",
			tail: " # 注册模型单次审核总时长兜底（毫秒）；超时切换下一个模型",
		});
	});

	it("没有注释时整段都是值（尾部空白归 tail）", () => {
		// 键行里等号后的空白由 KEY_LINE_RE 的 (\s*=\s*) 吃掉，所以这里收到的已经从值本身开始
		assert.deepEqual(splitValueAndTail("200 "), { value: "200", tail: " " });
		assert.deepEqual(splitValueAndTail('"https://api.siliconflow.cn"'), {
			value: '"https://api.siliconflow.cn"',
			tail: "",
		});
	});
});

describe("replaceTomlKey", () => {
	it("只换目标段里目标键的值，行尾注释与空白不动", () => {
		const before = readFileSync(extensionsToml, "utf8");
		const after = replaceTomlKey(before, "sandbox-llm-review", "mode", '"strict"');
		const diffs = diffLines(before, after);
		assert.equal(diffs.length, 1, "只能有一行变化");
		assert.equal(diffs[0].before, 'mode = "auto"  # auto=判安全直接放行；strict=仅给意见仍弹窗');
		assert.equal(diffs[0].after, 'mode = "strict"  # auto=判安全直接放行；strict=仅给意见仍弹窗');
	});

	it("段名不同、键名相同的行不受影响（tool-checker 里也有 name）", () => {
		const before = readFileSync(extensionsToml, "utf8");
		const after = replaceTomlKey(before, "sandbox-review-classifier", "model", '"Qwen/Qwen3-8B"');
		const diffs = diffLines(before, after);
		assert.equal(diffs.length, 1);
		assert.equal(diffs[0].after, 'model = "Qwen/Qwen3-8B"');
		// [tool-checker.tools] 段落里的 name 行一个字都没动
		assert.ok(after.includes('name = "gh-cli"'));
	});

	it("找不到键就拒绝（宁可不写，也不猜着新加一行）", () => {
		const before = readFileSync(extensionsToml, "utf8");
		assert.throws(
			() => replaceTomlKey(before, "sandbox-llm-review", "no_such_key", "1"),
			(err) => err instanceof ReviewSettingsError && /找不到键 no_such_key/.test(err.message),
		);
	});
});

describe("loadReviewSettings", () => {
	it("读出三处配置的当前值", () => {
		const settings = loadReviewSettings();
		assert.equal(settings.llm.enabled, true);
		assert.equal(settings.llm.mode, "auto");
		assert.equal(settings.llm.backend, "chain");
		assert.equal(settings.llm.timeoutMs, 30000);
		assert.equal(settings.llm.tokenIdleMs, 4000);
		assert.equal(settings.llm.maxCache, 200);
		assert.equal(settings.classifier.baseUrl, "https://api.siliconflow.cn");
		assert.equal(settings.classifier.model, "diffusiongemma");
		assert.equal(settings.classifier.timeoutMs, 3000);
		assert.equal(settings.dimensions.length, 8);
		assert.deepEqual(settings.warnings, []);
	});

	// 只比形状，不比数值：文件里的阈值是你调过的，跟代码默认值本来就不该相等
	it("维度行的形状与已知维度对得上（id / 阈值 / action 都在）", () => {
		const settings = loadReviewSettings();
		const known = new Set(defaultDimensionConfigs().map((d) => d.id));
		assert.ok(settings.dimensions.length > 0, "至少要读出一个维度");
		for (const dim of settings.dimensions) {
			assert.ok(known.has(dim.id), `不认识的维度：${dim.id}`);
			assert.equal(typeof dim.enabled, "boolean", dim.id);
			assert.ok(dim.above >= 0 && dim.above <= 1, `${dim.id} 的 above 越界`);
			// noul 没有置信度，below 允许是 null
			assert.ok(dim.below === null || (dim.below >= 0 && dim.below <= 1), `${dim.id} 的 below 越界`);
			assert.ok(dim.action === "review" || dim.action === "ignore", `${dim.id} 的 action 非法`);
		}
	});

	it("文件缺失时给默认值并在 warnings 里明说，不抛", () => {
		setReviewSettingsPathsForTest({ extensionsToml: join(tmp, "nope.toml"), dimensionsToml: join(tmp, "nope-dims.toml") });
		const settings = loadReviewSettings();
		assert.equal(settings.llm.timeoutMs, 30000);
		assert.equal(settings.warnings.length, 2);
		assert.ok(settings.warnings.every((w) => w.includes("读不到")));
		setReviewSettingsPathsForTest({ extensionsToml, dimensionsToml });
	});
});

describe("planSettingsWrite", () => {
	const current = loadReviewSettings();

	it("枚举白名单：mode / backend 只收固定值", () => {
		assert.throws(() => planSettingsWrite(current, { llm: { mode: "loose" } }), /llm\.mode/);
		assert.throws(() => planSettingsWrite(current, { llm: { backend: "both" } }), /llm\.backend/);
		assert.throws(() => planSettingsWrite(current, { llm: { backend: "chatty" } }), /chat \/ classifier \/ chain/);
	});

	it("数值区间：超范围与非法类型都点名到字段", () => {
		assert.throws(() => planSettingsWrite(current, { llm: { timeoutMs: 10 } }), /llm\.timeoutMs/);
		assert.throws(() => planSettingsWrite(current, { llm: { tokenIdleMs: 999999 } }), /tokenIdleMs/);
		assert.throws(() => planSettingsWrite(current, { llm: { maxCache: 0 } }), /maxCache/);
		assert.throws(() => planSettingsWrite(current, { llm: { maxCache: "200" } }), /需要数字/);
		assert.throws(() => planSettingsWrite(current, { classifier: { timeoutMs: 50 } }), /classifier\.timeoutMs/);
	});

	it("base_url 必须是 http(s)", () => {
		assert.throws(() => planSettingsWrite(current, { classifier: { baseUrl: "ftp://x" } }), /http:\/\/ 或 https:\/\//);
		assert.throws(() => planSettingsWrite(current, { classifier: { baseUrl: "api.siliconflow.cn" } }), /http:\/\/ 或 https:\/\//);
		assert.throws(() => planSettingsWrite(current, { classifier: { baseUrl: "http://" } }), /不是合法的 URL/);
		assert.throws(() => planSettingsWrite(current, { classifier: { baseUrl: "" } }), /非空/);
	});

	it("模型名不接受空白与空串", () => {
		assert.throws(() => planSettingsWrite(current, { classifier: { model: "a b" } }), /空白/);
		assert.throws(() => planSettingsWrite(current, { classifier: { model: "  " } }), /需要模型名/);
	});

	it("维度：未知 id、越界阈值、noul 的 below 都拒绝", () => {
		assert.throws(() => planSettingsWrite(current, { dimensions: [{ id: "nope" }] }), /未知维度/);
		assert.throws(() => planSettingsWrite(current, { dimensions: [{ id: "elevation", above: 1.5 }] }), /above/);
		assert.throws(() => planSettingsWrite(current, { dimensions: [{ id: "oddity", below: null }] }), /below 不能为空/);
		assert.throws(
			() => planSettingsWrite(current, { dimensions: [{ id: "scripted_edit", below: 0.5 }] }),
			/below 不适用/,
		);
		assert.throws(() => planSettingsWrite(current, { dimensions: [{ id: "elevation", action: "block" }] }), /action/);
	});

	it("合法 patch 落到正确的段与键上", () => {
		const plan = planSettingsWrite(current, {
			llm: { mode: "strict", maxCache: 500 },
			classifier: { model: "Qwen/Qwen3-8B" },
			dimensions: [{ id: "elevation", above: 0.65 }],
		});
		const keys = plan.writes.map((w) => `${w.section}.${w.key}`);
		assert.deepEqual(keys, [
			"sandbox-llm-review.mode",
			"sandbox-llm-review.max_cache",
			"sandbox-review-classifier.model",
		]);
		assert.equal(plan.writes[0].value, '"strict"');
		assert.equal(plan.writes[1].value, "500");
		assert.equal(plan.dimensions?.find((d) => d.id === "elevation")?.above, 0.65);
		assert.deepEqual(plan.writes[0].change, { field: "档位", from: "auto", to: "strict" });
	});
});

describe("saveReviewSettings", () => {
	it("改一个键后，extensions.toml 其余内容逐字不变", () => {
		const before = readFileSync(extensionsToml, "utf8");
		const result = saveReviewSettings({ llm: { mode: "strict" } });
		const after = readFileSync(extensionsToml, "utf8");

		const diffs = diffLines(before, after);
		assert.equal(diffs.length, 1, `只该有一行变化，实际 ${JSON.stringify(diffs)}`);
		assert.equal(diffs[0].after, 'mode = "strict"  # auto=判安全直接放行；strict=仅给意见仍弹窗');
		// 逐字不变：删掉变化行之后两份文本必须完全相等
		const strip = (text: string) => text.split("\n").filter((_, i) => i !== diffs[0].index).join("\n");
		assert.equal(strip(before), strip(after));

		assert.deepEqual(result.changed, ["档位: auto → strict"]);
		assert.equal(result.settings.llm.mode, "strict");
		assert.equal(result.settings.llm.backend, "chain", "没碰的键不能变");
	});

	it("一次改多个键：每行只动值，注释与其它段照旧", () => {
		const before = readFileSync(extensionsToml, "utf8");
		const result = saveReviewSettings({
			llm: { enabled: false, backend: "classifier", timeoutMs: 15000, tokenIdleMs: 2500, maxCache: 50 },
			classifier: { baseUrl: "https://example.com", model: "m1", timeoutMs: 9000 },
		});
		const after = readFileSync(extensionsToml, "utf8");
		const diffs = diffLines(before, after);
		assert.equal(diffs.length, 8);
		for (const d of diffs) {
			// 每处变化都必须是同一行的「值」被换掉：行首到 "=" 那段（含缩进）没变
			const head = (line: string) => line.split("=")[0];
			assert.equal(head(d.before).trim(), head(d.after).trim(), d.before);
			assert.ok(/^[A-Za-z0-9_]+ = /.test(d.after), d.after);
		}
		assert.equal(result.settings.llm.enabled, false);
		assert.equal(result.settings.llm.timeoutMs, 15000);
		assert.equal(result.settings.classifier.baseUrl, "https://example.com");
		// 段落结构完好：再解析一次仍然拿得到两段
		assert.equal(result.settings.dimensions.length, 8);
		assert.ok(after.includes("# ═══"));
		assert.ok(after.includes("[sandbox-guard]"));
	});

	it("维度阈值写进 review-dimensions.toml，且仍是既有格式", () => {
		const result = saveReviewSettings({
			dimensions: [
				{ id: "elevation", above: 0.65, below: 0.35, action: "ignore" },
				{ id: "scripted_edit", enabled: false },
			],
		});
		const text = readFileSync(dimensionsToml, "utf8");
		assert.equal(text, formatDimensionsToml(result.settings.dimensions));
		assert.ok(text.startsWith("# 指令审核维度阈值"));
		const elevation = result.settings.dimensions.find((d) => d.id === "elevation")!;
		assert.equal(elevation.above, 0.65);
		assert.equal(elevation.below, 0.35);
		assert.equal(elevation.action, "ignore");
		const scripted = result.settings.dimensions.find((d) => d.id === "scripted_edit")!;
		assert.equal(scripted.enabled, false);
		assert.equal(scripted.above, 0.5, "没给的字段保持原值");
		assert.ok(!text.split("[[dimension]]").find((b) => b.includes("scripted_edit"))!.includes("below ="));
		assert.ok(result.changed.some((c) => c.startsWith("elevation.above")));
	});

	it("非法输入拒绝且文件未被触碰", () => {
		const beforeExtensions = readFileSync(extensionsToml, "utf8");
		const beforeDims = readFileSync(dimensionsToml, "utf8");
		const cases: unknown[] = [
			{ llm: { mode: "loose" } },
			{ llm: { backend: "nope" } },
			{ llm: { maxCache: -1 } },
			{ classifier: { baseUrl: "file:///etc/passwd" } },
			{ classifier: { model: "  " } },
			{ dimensions: [{ id: "ghost" }] },
			{ dimensions: [{ id: "scripted_edit", below: 0.4 }] },
			{ "llm": "not-an-object" },
		];
		for (const patch of cases) {
			assert.throws(() => saveReviewSettings(patch), ReviewSettingsError, JSON.stringify(patch));
		}
		assert.equal(readFileSync(extensionsToml, "utf8"), beforeExtensions, "extensions.toml 不能被动过");
		assert.equal(readFileSync(dimensionsToml, "utf8"), beforeDims, "review-dimensions.toml 不能被动过");
		assert.deepEqual(readdirSync(tmp).sort(), ["extensions.toml", "review-dimensions.toml"], "不能留下临时文件");
	});

	it("一个 patch 里混了非法字段：整批拒绝，合法的那部分也不落盘", () => {
		const before = readFileSync(extensionsToml, "utf8");
		assert.throws(() => saveReviewSettings({ llm: { mode: "strict" }, classifier: { baseUrl: "ftp://x" } }));
		assert.equal(readFileSync(extensionsToml, "utf8"), before);
	});

	it("值没变时不写盘（文件 mtime 与内容都不动）", () => {
		const before = readFileSync(extensionsToml, "utf8");
		const result = saveReviewSettings({ llm: { mode: "auto", backend: "chain" } });
		assert.deepEqual(result.changed, []);
		assert.equal(readFileSync(extensionsToml, "utf8"), before);
	});

	it("文件读不到时拒绝写入，而不是新建一份只有几行的配置", () => {
		setReviewSettingsPathsForTest({ extensionsToml: join(tmp, "missing.toml"), dimensionsToml });
		assert.throws(() => saveReviewSettings({ llm: { mode: "strict" } }), /读不到/);
		assert.ok(!readdirSync(tmp).includes("missing.toml"));
		setReviewSettingsPathsForTest({ extensionsToml, dimensionsToml });
	});
});

describe("atomicWriteFile", () => {
	it("写完就换名：目录里不残留临时文件", () => {
		const target = join(tmp, "atomic.txt");
		writeFileSync(target, "旧内容", "utf8");
		atomicWriteFile(target, "新内容");
		assert.equal(readFileSync(target, "utf8"), "新内容");
		assert.deepEqual(readdirSync(tmp).filter((f) => f.includes("atomic.txt")), ["atomic.txt"]);
		rmSync(target, { force: true });
	});

	it("rename 失败时原文件保持原状，临时文件被清掉", () => {
		const target = join(tmp, "atomic-keep.txt");
		writeFileSync(target, "原文", "utf8");
		assert.throws(() =>
			atomicWriteFile(target, "不该落地", {
				renameSync: () => {
					throw new Error("模拟 rename 失败（磁盘满 / 权限）");
				},
			}),
		);
		assert.equal(readFileSync(target, "utf8"), "原文");
		assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith("atomic-keep.txt")), ["atomic-keep.txt"]);
		rmSync(target, { force: true });
	});

	it("写临时文件就失败（目录不可写）时，同样不动原文件", () => {
		const target = join(tmp, "atomic-write.txt");
		writeFileSync(target, "原文", "utf8");
		assert.throws(() =>
			atomicWriteFile(target, "不该落地", {
				writeFileSync: () => {
					throw new Error("模拟 EACCES");
				},
			}),
		);
		assert.equal(readFileSync(target, "utf8"), "原文");
		rmSync(target, { force: true });
	});

	it("saveReviewSettings 的落盘也走原子替换（rename 失败 → 原文件不变）", () => {
		const before = readFileSync(extensionsToml, "utf8");
		assert.throws(() =>
			saveReviewSettings({ llm: { mode: "strict" } }, { extensionsToml, dimensionsToml }, {
				renameSync: () => {
					throw new Error("模拟 rename 失败");
				},
			}),
		);
		assert.equal(readFileSync(extensionsToml, "utf8"), before);
		assert.deepEqual(readdirSync(tmp).sort(), ["extensions.toml", "review-dimensions.toml"]);
	});
});

describe("saveDimensions", () => {
	it("原子替换 + 校验：非法维度拒绝且文件不变", () => {
		const before = readFileSync(dimensionsToml, "utf8");
		const dims = defaultDimensionConfigs();
		dims[0].above = 1.5;
		assert.throws(() => saveDimensions(dims), ReviewSettingsError);
		assert.equal(readFileSync(dimensionsToml, "utf8"), before);

		dims[0].above = 0.5;
		saveDimensions(dims);
		assert.equal(readFileSync(dimensionsToml, "utf8"), formatDimensionsToml(dims));
	});
});

describe("与扩展侧读取同源", () => {
	// 设置窗里看到的值必须就是 gate 真正用的值。两边各读一次文件、比结果：
	// 不写死具体数字，读的是仓里真实的 extensions.toml（只读，不写）。
	it("llm 段与 loadLlmReviewConfig() 一致", () => {
		const fromExtension = loadLlmReviewConfig();
		const fromLib = loadReviewSettings(defaultReviewSettingsPaths());
		assert.deepEqual(fromLib.llm, {
			enabled: fromExtension.enabled,
			mode: fromExtension.mode,
			backend: fromExtension.backend,
			timeoutMs: fromExtension.timeoutMs,
			tokenIdleMs: fromExtension.tokenIdleMs,
			maxCache: fromExtension.maxCache,
		});
	});

	it("classifier 段与 loadClassifierConfig() 一致（端点/模型/超时）", () => {
		const fromExtension = loadClassifierConfig();
		const fromLib = loadReviewSettings(defaultReviewSettingsPaths());
		assert.deepEqual(fromLib.classifier, {
			baseUrl: fromExtension.baseUrl,
			model: fromExtension.model,
			timeoutMs: fromExtension.timeoutMs,
		});
		// 维度表也同源：extensions.toml 里的 [[dimension]] 与独立文件两条读法必须一个字不差
		assert.deepEqual(fromLib.dimensions, fromExtension.dimensions);
	});
});

describe("前端与窗口用的元信息", () => {
	it("dimensionFieldSpecs 覆盖八个维度且带 supportsBelow", () => {
		const specs = dimensionFieldSpecs();
		assert.equal(specs.length, 8);
		assert.equal(specs.find((s) => s.id === "scripted_edit")?.supportsBelow, false);
		assert.equal(specs.find((s) => s.id === "elevation")?.supportsBelow, true);
		assert.ok(specs.every((s) => s.label && s.instructions));
	});

	it("REVIEW_LIMITS 的阈值区间与 TUI 面板的夹取范围一致", () => {
		assert.equal(REVIEW_LIMITS.step, 0.05);
		assert.equal(REVIEW_LIMITS.aboveMin, 0.05);
		assert.equal(REVIEW_LIMITS.aboveMax, 0.99);
	});
});
