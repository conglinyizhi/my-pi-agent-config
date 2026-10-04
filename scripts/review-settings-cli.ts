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

	// 常驻模式：给 Electron 主进程用。每次保存都冷启一个 node 进程 + 转译一遍
	// 模块图（实测 ~0.6s 起），窗口一按保存就卡；常驻之后只有第一次付这个钱。
	if (args.command === "serve") {
		serveStdio();
		return;
	}

	emitOnce(args.command, args.json, paths);
}

/** 一次请求的完整处理：serve 与一次性两种入口共用同一份逻辑 */
function handleRequest(
	command: string,
	json: string | undefined,
	paths: ReturnType<typeof resolveReviewSettingsPaths>,
): { payload: CliOutput; code: number } {
	if (command === "get") {
		try {
			const settings = loadReviewSettings(paths);
			return { payload: { ok: true, settings, specs: dimensionFieldSpecs(), limits: REVIEW_LIMITS, paths }, code: 0 };
		} catch (err) {
			return { payload: { ok: false, error: err instanceof Error ? err.message : String(err) }, code: 2 };
		}
	}

	if (command === "set") {
		const raw = (json ?? readStdin()).trim();
		if (raw === "") return { payload: { ok: false, error: "set 需要 JSON（命令行参数或 stdin）" }, code: 2 };
		let patch: unknown;
		try {
			patch = JSON.parse(raw);
		} catch (err) {
			return {
				payload: { ok: false, error: `patch 不是合法 JSON：${err instanceof Error ? err.message : String(err)}` },
				code: 2,
			};
		}
		try {
			const result = saveReviewSettings(patch, paths);
			return {
				payload: {
					ok: true,
					changed: result.changed,
					settings: result.settings,
					specs: result.specs,
					limits: result.limits,
					paths: result.paths,
				},
				code: 0,
			};
		} catch (err) {
			if (err instanceof ReviewSettingsError) {
				const issues: ReviewIssue[] = err.issues;
				process.stderr.write(`${err.message}\n`);
				return { payload: { ok: false, issues }, code: 1 };
			}
			return { payload: { ok: false, error: err instanceof Error ? err.message : String(err) }, code: 2 };
		}
	}

	return { payload: { ok: false, error: "用法错误：需要一个子命令 get 或 set" }, code: 2 };
}

function emitOnce(command: string, json: string | undefined, paths: ReturnType<typeof resolveReviewSettingsPaths>): never {
	const { payload, code } = handleRequest(command, json, paths);
	emit(payload, code);
}

/**
 * 常驻桥：stdin 一行一个请求 `{"id":…,"cmd":"get|set","patch":…}`，
 * stdout 一行一个响应（原请求的 id 原样带回）。读不到完整行就一直攒着。
 */
function serveStdio(): void {
	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		let cut = buffer.indexOf("\n");
		while (cut >= 0) {
			const line = buffer.slice(0, cut);
			buffer = buffer.slice(cut + 1);
			if (line.trim() !== "") {
				process.stdout.write(`${JSON.stringify(respondToLine(line))}\n`);
			}
			cut = buffer.indexOf("\n");
		}
	});
	process.stdin.on("end", () => process.exit(0));
}

function respondToLine(line: string): CliOutput {
	let request: { id?: unknown; cmd?: unknown; patch?: unknown };
	try {
		request = JSON.parse(line) as { id?: unknown; cmd?: unknown; patch?: unknown };
	} catch (err) {
		return { ok: false, error: `请求不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
	}
	const command = typeof request.cmd === "string" ? request.cmd : "";
	const json = request.patch === undefined ? undefined : JSON.stringify(request.patch);
	const { payload } = handleRequest(command, json, resolveReviewSettingsPaths());
	if (request.id !== undefined) payload.id = request.id;
	return payload;
}

main();
