#!/usr/bin/env node
// 审核窗折叠效果的自查工具：拿一段真实形状的 run_code 脚本，走一遍
// 重排 → 扫描 → 折叠事实 → 拼请求，把"审核窗首屏会长什么样"打在终端里。
//
// 用法：
//   node --experimental-strip-types scripts/gate-preview-demo.ts           # 只看文本首屏 + 请求落在哪
//   node --experimental-strip-types scripts/gate-preview-demo.ts --open    # 顺手把审核窗开起来
//
// 为什么要它：折叠是给人看的东西，光靠单测看不出"首屏还剩几行"。
// 真跑一次 run_code 要过模型与审批链，开发时太重。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatScriptForDisplay } from "../lib/script-format.ts";
import { scanScript } from "../lib/ptc-analyze.ts";
import { scriptEffectsOf } from "../lib/ptc-audit.ts";
import { foldScript } from "../gui/frontend/src/domain/gate/script-fold.js";

const SOURCE = [
	"const files = await tools.ls({ path: '/home/clyzhi/.pi/agent/lib' });",
	"",
	"if (files.length > 0) {",
	"        const out = await tools.write({",
	"              path: '/home/clyzhi/.pi/agent/lib/timeline.ts',",
	"              content: files.join(', '),",
	"        });",
	"  await tools.write({ path: '/tmp/notes-copy.txt', content: 'first line' });",
	"   const built = await tools.bash({ command: 'node_modules/.bin/tsc --noEmit', cwd: '/home/clyzhi/.pi/agent' });",
	"  await tools.edit({ path: '/home/clyzhi/.pi/agent/lib/timeline.ts', old: 'const a = 1;', new: 'const a = 2;' });",
	"      const body = await tools.read({ path: '/tmp/notes.txt' });",
	"  await tools.write({ path: '/home/clyzhi/.pi/agent/lib/timeline.ts', content: body });",
	"  await tools.apply_patch({ patch: \"*** Update File: /tmp/notes.txt\\n@@ -1 +1 @@\\n-old line\\n+new line\\n\" });",
	"  await tools.cleanup_everything({ path: '/etc/hosts' });",
	"}",
].join("\n");

async function main(): Promise<void> {
	const display = await formatScriptForDisplay(SOURCE);
	const text = display.text;
	const effects = scriptEffectsOf({
		script: SOURCE,
		reason: "演示",
		tools: [],
		scan: await scanScript(SOURCE),
		display: text,
		displayScan: await scanScript(text),
		cwd: process.cwd(),
		home: process.env.HOME,
	});

	const model = foldScript(text, effects.editCalls ?? [], []);
	const screen = model.segments
		.map((segment) => (segment.kind === "chip" ? `«${segment.chip.label}»` : segment.text))
		.join("");
	console.log(`重排：${display.formatted ? "成功" : `退回原文（${display.reason}）`}`);
	console.log(`折叠：${model.chips.length} 颗芯片（灰=改文件 ${model.chips.filter((c) => c.tone === "file").length}，橙=shell ${model.chips.filter((c) => c.tone === "shell").length}）`);
	console.log("");
	console.log("=== 审核窗首屏（芯片用 «» 标） ===");
	console.log(screen);

	const merged = effects.mergedChanges ?? [];
	if (merged.length > 0) {
		console.log("");
		console.log("=== 同文件改动合并（按字面量推演） ===");
		for (const entry of merged) {
			const head = [entry.path, entry.status, entry.ops + " 处", "+" + entry.added + "/-" + entry.removed];
			if (entry.baseAssumedEmpty) head.push("改前按空文件算");
			if (entry.truncated) head.push("只摆前一段");
			console.log(head.join("  "));
			if (entry.reason) console.log("  ! " + entry.reason);
			for (const block of entry.blocks) {
				if (block.type === "gap") {
					console.log("  ⋯ 跳过 " + block.count + " 行未改动");
					continue;
				}
				for (const row of block.rows) {
					const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
					console.log("  " + sign + " " + row.text);
				}
			}
		}
	}
	const patchCall = (effects.editCalls ?? []).find((call) => typeof call.patchText === "string");
	if (patchCall && typeof patchCall.patchText === "string") {
		console.log("");
		console.log("=== 补丁原文（照摆不重算） ===");
		console.log(patchCall.patchText.trim());
	}

	const dir = join(tmpdir(), "pi-gate-preview");
	mkdirSync(dir, { recursive: true });
	const requestPath = join(dir, "request.json");
	writeFileSync(
		requestPath,
		JSON.stringify(
			{
				feedback: false,
				kind: "audit",
				command: text,
				taskId: "preview-demo",
				rules: [{ name: "危险调用", tip: "这个工具会改动系统状态", matched: ["cleanup_everything"] }],
				// 两段模型意见都要有，否则右栏只有半截，看不出排版：
				// chatReview = 大模型（文本模型）那一路，dimensions = System One 分类器那一路
				review: {
					verdict: "risky",
					reason: "脚本要改仓里的文件并跑构建",
					chatReview: {
						verdict: "risky",
						reason: "脚本会改仓库里的文件并跑构建，还调用了一个会动系统状态的工具",
						suggestion: "确认只改该改的文件，cleanup_everything 的路径是不是你要的",
						opinion: "看下来像是要把 notes.txt 的内容覆盖到 timeline.ts，顺带跑一次类型检查；风险点是末尾那个 cleanup。",
					},
					dimensions: [
						{ id: "整体可疑", label: "整体可疑", type: "system1", risk: 0.5, confidence: 0.0, above: 0.5, below: null, triggered: true, reason: "有些不对劲，让用户扫一眼更稳妥" },
						{ id: "副作用面", label: "副作用面", type: "system1", risk: 0.25, confidence: 0.6, above: 0.5, below: null, triggered: false },
						{ id: "越界", label: "越界", type: "system1", risk: 0.1, confidence: 0.9, above: 0.6, below: null, triggered: false },
						{ id: "脚本改写", label: "脚本改写", type: "system1", disabled: true, disabledNote: "本次场景没问过" },
					],
				},
				subject: "script",
				scriptEffects: effects,
			},
			null,
			2,
		),
	);
	console.log("");
	console.log(`请求 JSON：${requestPath}`);

	if (!process.argv.includes("--open")) {
		console.log("加 --open 可以直接把审核窗开起来看。");
		return;
	}
	const gui = join(process.cwd(), "bin", "gui");
	const child = spawn(gui, ["gate", requestPath, join(dir, "response.json")], { stdio: "inherit" });
	child.on("exit", (code) => process.exit(code ?? 0));
}

await main();
