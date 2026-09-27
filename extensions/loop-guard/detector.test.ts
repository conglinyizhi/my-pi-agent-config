// loop-guard/detector.test.ts — 检测核心语义测试
//
// 跑法：node --test --experimental-strip-types extensions/loop-guard/detector.test.ts
//
// 这里的所有正例/反例都取自 2026-09 的真实事故与 408 个历史 session 的清点结果，
// 是「不误伤」这条底线的回归防线 —— 改动 detector 后必须全绿。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_OPTIONS,
	LoopDetector,
	hasSubstance,
	judgeStats,
	normalizeLine,
	windowStats,
	type LoopGuardOptions,
	type LoopHit,
} from "./detector.ts";

const opts = (over: Partial<LoopGuardOptions> = {}): LoopGuardOptions => ({ ...DEFAULT_OPTIONS, ...over });

/** 按固定片长喂完整块，返回首次命中 */
function run(text: string, over: Partial<LoopGuardOptions> = {}, chunk = 48) {
	const det = new LoopDetector(over);
	let first = null;
	let abort = null;
	for (let i = 0; i < text.length; i += chunk) {
		const hit = det.feed(text.slice(i, i + chunk));
		if (hit && !first) first = hit;
		if (hit?.severity === "abort" && !abort) abort = hit;
	}
	return { first, abort };
}

/** 复刻事故里的停滞形态：几句占位短话交替重复 */
function stallLoop(cycles: number, lines = ["好。", "（输出）", "（现在）", "**（报告）**"]): string {
	const out: string[] = [];
	for (let i = 0; i < cycles; i++) for (const l of lines) out.push(l, "");
	return out.join("\n");
}

/** 极纯循环：只有一句「好。」反复（极纯档专抓的形态） */
function pureStall(cycles: number): string {
	const out: string[] = [];
	for (let i = 0; i < cycles; i++) out.push("好。", "");
	return out.join("\n");
}

/**
 * 按固定片长喂完整个块，收集全部命中，并记下极纯档首次 armed 的位置。
 * 用 chunk=8 贴近真机 delta 粒度。
 */
function runAll(text: string, over: Partial<LoopGuardOptions> = {}, chunk = 8) {
	const det = new LoopDetector(over);
	const hits: LoopHit[] = [];
	let armAt: number | null = null;
	let armChars = 0;
	for (let i = 0; i < text.length; i += chunk) {
		const hit = det.feed(text.slice(i, i + chunk));
		if (det.pureArmed && armAt === null) {
			armAt = det.fedChars;
			armChars = det.pureArmedAtChars;
		}
		if (hit) hits.push(hit);
	}
	return { det, hits, armAt, armChars };
}

/** 复刻 tar 刷屏：同一句长警告重复 */
function tarEcho(times: number): string {
	return Array.from({ length: times }, () => "tar: 忽略未知的扩展头关键字‘SCHILY.fflags’").join("\n");
}

/** 复刻 CI 矩阵日志：固定模板 + 每次变化的任务头 */
function ciLog(jobs: number): string {
	const out: string[] = [];
	for (let i = 0; i < jobs; i++) {
		out.push(`✓ build (job-${i}, amd64, tar.gz) in 2m3${i % 10}s (ID 9282258650${i})`);
		for (const step of ["Set up job", "Run actions/checkout@v6", "Set up Go", "Build helper", "Build binary", "Upload artifact"]) {
			out.push(`  ✓ ${step}`);
		}
	}
	return out.join("\n");
}

describe("normalizeLine", () => {
	it("削掉成对强调与列表标记，保留行内符号", () => {
		assert.equal(normalizeLine("**（输出）**"), "（输出）");
		assert.equal(normalizeLine("- 好。"), "好。");
		assert.equal(normalizeLine("1. 做。"), "做。");
		assert.equal(normalizeLine("> `code`"), "code");
		assert.equal(normalizeLine("a * b"), "a * b");
		assert.equal(normalizeLine("  多   空格  "), "多 空格");
	});
});

describe("hasSubstance", () => {
	it("纯符号行不算内容", () => {
		for (const s of ["}", "```", "│", "──┬──", "---", "```js", "0,", "|", "..."]) {
			assert.equal(hasSubstance(s), false, `${JSON.stringify(s)} 不该算内容`);
		}
	});
	it("短句、路径、日志行算内容", () => {
		for (const s of ["好。", "（输出）", "Emitting.", "✓ Set up job", "tar: 忽略未知的扩展头关键字"]) {
			assert.equal(hasSubstance(s), true, `${JSON.stringify(s)} 该算内容`);
		}
	});
});

describe("真循环必须抓到", () => {
	it("中文占位句循环：warn 且 abort", () => {
		const { first, abort } = run(stallLoop(1200));
		assert.ok(first, "应该命中");
		assert.equal(first.severity, "warn");
		assert.ok(abort, "重复量足够后应升级为 abort");
		assert.ok(first.alphabet <= 10, `字母表应该很小，实际 ${first.alphabet}`);
		assert.ok(first.avgLineChars <= 20, `平均行长应该短，实际 ${first.avgLineChars}`);
	});

	it("英文占位句循环（较长的句子）也要抓到", () => {
		const text = stallLoop(1500, ["Let me do it.", "Let me write.", "Emitting.", "Let me write the command."]);
		const { abort } = run(text);
		assert.ok(abort, "英文停滞句同样应命中");
	});

	it("单句重复（字母表=1）应抓到", () => {
		const { first } = run(stallLoop(3000, ["好。"]));
		assert.ok(first);
		assert.equal(first.alphabet, 1);
	});

	it("Warn 级门槛早于 Abort 级门槛", () => {
		const text = stallLoop(2000);
		const { first, abort } = run(text);
		assert.ok(first && abort);
		assert.ok(first.offset < abort.offset, "warn 应该先于 abort 触发");
	});
});

describe("误伤回归：正常输出绝不能碰", () => {
	it("tar 同款长警告刷屏（平均行长 31）", () => {
		const text = tarEcho(400) + "\nc-cpp DONE: 5068 files\n";
		const st = windowStats(
			text.split("\n").map(normalizeLine).filter(Boolean),
			opts(),
		);
		assert.ok(st, "窗口统计应可用");
		assert.ok(st.avgLineChars > DEFAULT_OPTIONS.maxAvgLineChars, "平均行长应超出上限");
		assert.equal(run(text).first, null, "不该命中");
	});

	it("CI 矩阵日志：模板重复但每次任务头都不同", () => {
		const text = ciLog(120);
		assert.equal(run(text).first, null, "不该命中");
		// 挡住它的是字母表判据：窗口里新行的种类太多，说明内容在推进
		const lines = text.split("\n").map(normalizeLine).filter(Boolean);
		assert.equal(windowStats(lines, opts()), null, "新行种类过多时直接不成立");
	});

	it("50KB 单行回显（平均行长数万）", () => {
		const line = "oBAAE,OAAO,CAAC,IAAI,CAAC,GAAG,CAAC,".repeat(1400);
		const text = `${line}\n\n[Showing last 50.0KB of line 360 (line is 0B). Full output: /tmp/pi-bash-xxx]\n`;
		assert.equal(run(text).first, null, "不该命中");
	});

	it("hexdump / 内存转储", () => {
		const text = Array.from({ length: 200 }, (_, i) => `0x${i.toString(16).padStart(8, "0")}f7e00000 0x0000000000140204`).join("\n");
		assert.equal(run(text).first, null, "不该命中");
	});

	it("代码 / 表格里的纯符号行重复", () => {
		const text = Array.from({ length: 300 }, (_, i) => `.sel-${i} {\n  color: red;\n}\n`).join("");
		assert.equal(run(text).first, null, "不该命中");
		const braces = Array.from({ length: 4000 }, () => "}").join("\n");
		assert.equal(run(braces).first, null, "纯括号行不该命中");
	});

	it("正常推理：短句出现几次但内容在推进", () => {
		const text = Array.from(
			{ length: 60 },
			(_, i) => `先看第 ${i} 个引入文件。\n做。\n这个分支要处理嵌套括号，得跟踪深度。\n跑。\n结果：第 ${i} 个通过。`,
		).join("\n");
		assert.equal(run(text).first, null, "不该命中");
	});

	it("shell 报错刷屏（平均行长 28）", () => {
		const text = Array.from({ length: 300 }, () => "/bin/bash: 行 1: bc: 未找到命令").join("\n");
		assert.equal(run(text).first, null, "不该命中");
	});
});

describe("判据互不重合（消融口径）", () => {
	it("行长判据是精度的主要来源：放开行长会引入误伤", () => {
		const bad = tarEcho(400);
		const lines = bad.split("\n").map(normalizeLine).filter(Boolean);
		const strict = windowStats(lines, opts());
		assert.ok(strict);
		assert.equal(judgeStats(strict, opts()), null);
		// 把行长上限抬到 999 就会误判成停滞
		assert.equal(judgeStats(strict, opts({ maxAvgLineChars: 999, maxLongLineRatio: 1 })), "abort");
	});

	it("新行占比判据能挡住「循环刚开始、内容还在推进」", () => {
		// 前 400 行是各不相同的推理，后面才滑进 3 行循环：
		// 字母表虽然小，但窗口里还有大量新行，此时宁可不动手
		const prose = Array.from({ length: 400 }, (_, i) => `第 ${i} 步：检查第 ${i} 个引入文件的括号深度。`);
		const loop = Array.from({ length: 200 }, (_, i) => ["好。", "做。", "（输出）"][i % 3]);
		const lines = [...prose, ...loop].map(normalizeLine).filter(Boolean);
		const st = windowStats(lines, opts());
		if (st) {
			assert.ok(st.intruderRatio > DEFAULT_OPTIONS.maxIntruderRatio, "新行占比应该高于上限");
			assert.equal(judgeStats(st, opts()), null);
		}
		assert.equal(run([...prose, ...loop].join("\n")).first, null, "不该命中");
	});
});

describe("流式行为", () => {
	it("reset 后不残留上一块的判定", () => {
		const det = new LoopDetector();
		for (let i = 0; i < 40; i++) det.feed(stallLoop(200));
		assert.ok(det.alreadyFired);
		det.reset();
		assert.equal(det.alreadyFired, false);
		assert.equal(det.fedChars, 0);
		assert.equal(det.check(), null);
	});

	it("碎片化输入（每片 1 字符）与整块输入结论一致", () => {
		const text = stallLoop(700);
		assert.ok(run(text, {}, 1).first, "逐字喂也该命中");
		assert.ok(run(text, {}, 4096).first, "大块喂也该命中");
	});

	it("未收尾的行也算进窗口（行尾没有换行）", () => {
		const det = new LoopDetector();
		// 不换行地重复同一句，末尾不闭合
		const text = "好。".repeat(2000);
		let hit = null;
		for (let i = 0; i < text.length; i += 32) hit = det.feed(text.slice(i, i + 32)) ?? hit;
		assert.equal(hit, null, "没有换行分隔就不该当成行重复");
	});
});

describe("极纯档（附加的提前中止）", () => {
	it("极纯形态：先 armed，攒够确认量才中止，且早于现行 abort 线", () => {
		const { hits, armAt, armChars } = runAll(pureStall(5000));
		assert.ok(armAt !== null, "应该先进入 armed");
		assert.ok(
			armChars >= DEFAULT_OPTIONS.pureRepeatChars,
			`armed 时的重复量应达起始线，实得 ${armChars}`,
		);

		const pure = hits.find((h) => h.tier === "pure");
		assert.ok(pure, "确认期满后应该中止");
		assert.equal(pure.severity, "abort");
		assert.ok(
			pure.repeatChars - armChars >= DEFAULT_OPTIONS.pureConfirmChars,
			`确认量不足不该动手：armed@${armChars} → 命中@${pure.repeatChars}`,
		);
		assert.ok(pure.offset > armAt, "armed 当拍不能动手");

		const defAbort = hits.find((h) => h.severity === "abort" && h.tier !== "pure");
		assert.ok(defAbort, "现行档最终也会拦");
		assert.ok(pure.offset < defAbort.offset, "极纯档应该比现行 abort 早得多");
		assert.equal(pure.alphabet, 1);
		assert.equal(pure.avgLineChars, 2);
	});

	it("确认量越大，动手越晚；置 0 时 armed 当拍即中止", () => {
		const text = pureStall(5000);
		const zero = runAll(text, { pureConfirmChars: 0 });
		const mid = runAll(text, { pureConfirmChars: 800 });
		const late = runAll(text, { pureConfirmChars: 4000 });
		const pureOf = (r: ReturnType<typeof runAll>) => r.hits.find((h) => h.tier === "pure");
		const z = pureOf(zero);
		const m = pureOf(mid);
		const l = pureOf(late);
		assert.ok(z && m && l, "三档都该中止");
		assert.ok(z.offset < m.offset, "确认量为 0 时更早");
		assert.ok(m.offset < l.offset, "确认量 4000 时最晚");
		// 确认量为 0 时在 armed 当拍动手：命中重复量还贴着起始线（± 一个检查粒度）
		assert.ok(
			z.repeatChars < DEFAULT_OPTIONS.pureRepeatChars + 400,
			`确认量为 0 应该贴着起始线动手，实得 ${z.repeatChars}`,
		);
		assert.equal(zero.det.pureArmCount, 1, "确认量为 0 也是先 armed 再 fire");
		assert.ok(z.repeatChars >= DEFAULT_OPTIONS.pureRepeatChars);
	});

	it("确认期内块结束则静默放弃（贴块尾白拦）", () => {
		// 只够 armed、不够确认的块
		const short = pureStall(1050);
		const { hits, armAt } = runAll(short);
		assert.ok(armAt !== null, "应该已进入 armed");
		assert.equal(
			hits.find((h) => h.tier === "pure"),
			undefined,
			"确认期内不该中止",
		);

		// 块结束：reset 丢弃 armed，新块不受牵连
		const det = new LoopDetector();
		let armed = false;
		for (let i = 0; i < short.length; i += 8) {
			det.feed(short.slice(i, i + 8));
			if (det.pureArmed) armed = true;
		}
		assert.ok(armed, "块尾前应处在 armed");
		det.reset();
		assert.equal(det.pureArmed, false, "reset 应丢弃 armed");
		assert.equal(det.pureArmCount, 0);
		assert.equal(det.feed(pureStall(600)), null, "新块不该被上一块的 armed 牵连");
	});

	it("形态中断解除 armed，之后可重新 armed 并确认", () => {
		const det = new LoopDetector();
		const feedChunks = (text: string, stopOnPure = false) => {
			for (let i = 0; i < text.length; i += 8) {
				const hit = det.feed(text.slice(i, i + 8));
				if (stopOnPure && hit?.tier === "pure") return hit;
			}
			return null;
		};
		feedChunks(pureStall(1050));
		assert.equal(det.pureArmed, true, "先 armed");

		// 插一段内容在推进的推理：字母表被撑大，形态破裂
		const prose = Array.from(
			{ length: 60 },
			(_, i) => `第 ${i} 步：检查嵌套括号深度与变量作用域，然后继续往下看。`,
		).join("\n");
		feedChunks(`${prose}\n`);
		assert.equal(det.pureArmed, false, "形态中断应解除 armed");

		// 又滑回极纯循环：重新 armed，再攒够确认量才中止
		const hit = feedChunks(pureStall(1600), true);
		assert.ok(hit, "重新 armed 后确认期满应中止");
		assert.equal(hit.tier, "pure");
		assert.equal(det.pureArmCount, 2, "本块应该进过两次 armed");
	});

	it("关掉极纯档：不产生 pure 命中，现行档触发点一字不变", () => {
		const text = pureStall(5000);
		const on = runAll(text);
		const off = runAll(text, { pureEnabled: false });
		assert.equal(off.armAt, null, "关掉后不该 armed");
		assert.equal(
			off.hits.find((h) => h.tier === "pure"),
			undefined,
			"关掉后不该有 pure 命中",
		);
		// 现行档的 warn 与 abort 触发点两轮必须完全相同
		const firstBy = (hits: LoopHit[], severity: "warn" | "abort") =>
			hits.find((h) => h.tier !== "pure" && h.severity === severity)?.offset ?? null;
		assert.equal(firstBy(on.hits, "warn"), firstBy(off.hits, "warn"), "warn 触发点应不变");
		assert.equal(firstBy(on.hits, "abort"), firstBy(off.hits, "abort"), "abort 触发点应不变");
		assert.ok(firstBy(off.hits, "warn") !== null && firstBy(off.hits, "abort") !== null);
	});

	it("纯符号行重复不算极纯循环（与现行档同一条底线）", () => {
		const braces = Array.from({ length: 4000 }, () => "}").join("\n");
		const { hits } = runAll(braces);
		assert.equal(
			hits.find((h) => h.tier === "pure"),
			undefined,
			"纯符号行不该被极纯档掐",
		);
	});

	it("极纯档只在极纯形态下成立：长行日志与新行推进都不算", () => {
		// 同一句 20 字以上的话反复：形态过不了平均行长那道闸
		const longLine = Array.from({ length: 1500 }, () => "tar: 忽略未知的扩展头关键字‘SCHILY.fflags’").join("\n");
		assert.equal(runAll(longLine).det.pureArmCount, 0);
		// 每几行就冒一条新内容：过不了新行占比那道闸
		const ci = Array.from({ length: 400 }, (_, i) => `✓ build (job-${i}) in 2m3${i % 10}s\n  ✓ Set up job\n  ✓ Build binary`).join("\n");
		assert.equal(runAll(ci).det.pureArmCount, 0);
	});
});
