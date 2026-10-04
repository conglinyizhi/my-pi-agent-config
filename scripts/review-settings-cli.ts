#!/usr/bin/env node
// review-settings-cli.ts — 审核工作流设置的 JSON 桥（给 Electron 主进程用）
//
// 存在理由：Electron 主进程是纯 JS，不能 import 仓里的 .ts（lib/review-settings.ts）。
// 所以本脚本是唯一的桥：主进程 spawn 它，stdout 拿 JSON，不在主进程里重写任何 TOML 逻辑。
//
// 用法：
//   node --experimental-strip-types scripts/review-settings-cli.ts get
//   node --experimental-strip-types scripts/review-settings-cli.ts set '{"llm":{"mode":"strict"}}'
//   echo '<json>' | node --experimental-strip-types scripts/review-settings-cli.ts set
//
// 可选参数（默认走 ~/.pi/agent 下的真实配置）：
//   --extensions-toml <path>   指向 extensions.toml 的副本（测试/冒烟用）
//   --dimensions-toml <path>   指向 review-dimensions.toml 的副本
//
// 约定：**永远输出一行 JSON 到 stdout**（成功 {ok:true,…}，失败 {ok:false,issues:[…]}），
// 退出码 0 = 成功、1 = 校验失败（没落盘）、2 = 用法/IO 问题。人可读的错误只走 stderr。

import { readFileSync } from "node:fs";
import {
	REVIEW_LIMITS,
	ReviewSettingsError,
	defaultReviewSettingsPaths,
	dimensionFieldSpecs,
	loadReviewSettings,
	resolveReviewSettingsPaths,
	saveReviewSettings,
	setReviewSettingsPathsForTest,
	type ReviewIssue,
} from "../lib/review-settings.ts";

interface CliOutput {
	ok: boolean;
	[key: string]: unknown;
}

function emit(payload: CliOutput, code: number): never {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
	process.exit(code);
}

function usage(): never {
	process.stderr.write(
		[
			"用法：review-settings-cli.ts [--extensions-toml P] [--dimensions-toml P] <get|set> [json]",
			"  get                 读当前设置，输出 JSON",
			"  set <json>          应用一个 patch（也可从 stdin 读），输出 JSON；非法值拒绝且不落盘",
			"",
		].join("\n"),
	);
	emit({ ok: false, error: "用法错误：需要一个子命令 get 或 set" }, 2);
}

function parseArgs(argv: string[]): { command: string; json?: string; extensionsToml?: string; dimensionsToml?: string } {
	const flags: { extensionsToml?: string; dimensionsToml?: string } = {};
	let i = 0;
	while (i < argv.length && argv[i].startsWith("--")) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (value === undefined) {
			process.stderr.write(`缺少 ${flag} 的参数值\n`);
			usage();
		}
		if (flag === "--extensions-toml") flags.extensionsToml = value;
		else if (flag === "--dimensions-toml") flags.dimensionsToml = value;
		else {
			process.stderr.write(`未知参数 ${flag}\n`);
			usage();
		}
		i += 2;
	}
	const command = argv[i];
	if (command === undefined) usage();
	const json = argv[i + 1];
	return { command, json, ...flags };
}

/** 读 stdin（set 的 JSON 走管道时用；不阻塞地等 EOF） */
function readStdin(): string {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));

	// 指向副本时两个文件都要给全：只改扩展段、维度还读真实文件的话，
	// 一次 set 就可能把真实阈值文件写掉——测试里绝不允许发生。
	if (args.extensionsToml || args.dimensionsToml) {
		const defaults = defaultReviewSettingsPaths();
		setReviewSettingsPathsForTest({
			extensionsToml: args.extensionsToml ?? defaults.extensionsToml,
			dimensionsToml: args.dimensionsToml ?? defaults.dimensionsToml,
		});
	}

	const paths = resolveReviewSettingsPaths();

	if (args.command === "get") {
		try {
			const settings = loadReviewSettings(paths);
			emit({ ok: true, settings, specs: dimensionFieldSpecs(), limits: REVIEW_LIMITS, paths }, 0);
		} catch (err) {
			emit({ ok: false, error: err instanceof Error ? err.message : String(err) }, 2);
		}
	}

	if (args.command === "set") {
		const raw = (args.json ?? readStdin()).trim();
		if (raw === "") emit({ ok: false, error: "set 需要 JSON（命令行参数或 stdin）" }, 2);
		let patch: unknown;
		try {
			patch = JSON.parse(raw);
		} catch (err) {
			emit({ ok: false, error: `patch 不是合法 JSON：${err instanceof Error ? err.message : String(err)}` }, 2);
		}
		try {
			const result = saveReviewSettings(patch, paths);
			emit(
				{
					ok: true,
					changed: result.changed,
					settings: result.settings,
					specs: result.specs,
					limits: result.limits,
					paths: result.paths,
				},
				0,
			);
		} catch (err) {
			if (err instanceof ReviewSettingsError) {
				const issues: ReviewIssue[] = err.issues;
				process.stderr.write(`${err.message}\n`);
				emit({ ok: false, issues }, 1);
			}
			emit({ ok: false, error: err instanceof Error ? err.message : String(err) }, 2);
		}
	}

	usage();
}

main();
