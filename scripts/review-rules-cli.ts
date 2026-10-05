// scripts/review-rules-cli.ts — 审核规则表的命令行桥（GUI 主进程用它读写）
// 跑法：node --experimental-strip-types scripts/review-rules-cli.ts <命令> [参数]
//
//   get [--path <文件>]                读规则表：返回结构化的规则数组与校验问题
//   save [--path <文件>] --file <json>  存：先序列化成 toml，再原样读回来校验，过了才写盘
//   serve [--path <文件>]              常驻：stdin 一行一个请求，输出一行一个 JSON
//
// 协议同 review-settings-cli：请求 {"id":…,"cmd":"get|save","patch":{…}}，响应带同一个 id。
// 界面只交换结构化规则（驼峰），toml 的字段名由这一层负责——省得两边各写一份映射。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseReviewRules, rulesPath, stringifyReviewRules, type ReviewRule } from "../lib/review-rules.ts";

function defaultRoot(): string {
	return process.env.PI_AGENT_DIR ?? new URL("..", import.meta.url).pathname.replace(/\/$/, "");
}

function pathOf(options: { path?: string }): string {
	return options.path ?? rulesPath(defaultRoot());
}

interface Payload {
	ok: boolean;
	path: string;
	rules: ReviewRule[];
	problems: string[];
	error?: string;
}

function readAll(file: string): Payload {
	if (!existsSync(file)) return { ok: true, path: file, rules: [], problems: [] };
	const parsed = parseReviewRules(readFileSync(file, "utf8"));
	return { ok: parsed.problems.length === 0, path: file, rules: parsed.rules, problems: parsed.problems };
}

function saveAll(file: string, input: unknown): Payload {
	const rules = (input as { rules?: unknown })?.rules;
	if (!Array.isArray(rules)) return { ok: false, path: file, rules: [], problems: [], error: "save 需要 rules 数组" };
	const text = stringifyReviewRules(rules as ReviewRule[]);
	// 写完必须能原样读回来：解析器就是判据，这一层不许有第二套校验
	const check = parseReviewRules(text);
	if (check.problems.length > 0) {
		return { ok: false, path: file, rules: [], problems: check.problems, error: "校验没过，没有写盘" };
	}
	writeFileSync(file, text, { mode: 0o600 });
	return { ok: true, path: file, rules: check.rules, problems: [] };
}

function parseArgs(argv: string[]): { command: string; options: { path?: string; file?: string; json: boolean } } {
	const options: { path?: string; file?: string; json: boolean } = { json: false };
	let command = "";
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--path") { options.path = argv[++index]; continue; }
		if (arg === "--file") { options.file = argv[++index]; continue; }
		if (arg === "--json") { options.json = true; continue; }
		if (command === "") command = arg;
	}
	return { command, options };
}

function handle(cmd: string, patch: Record<string, unknown> | undefined, file: string): Payload {
	if (cmd === "get") return readAll(file);
	if (cmd === "save") return saveAll(file, patch);
	return { ok: false, path: file, rules: [], problems: [], error: "不认得的命令：" + cmd };
}

const { command, options } = parseArgs(process.argv.slice(2));
const file = pathOf(options);

if (command === "serve") {
	const rl = createInterface({ input: process.stdin });
	// 串行处理：请求之间共享一个文件，并发写会让"最后一个赢"变得不确定
	let queue: Promise<void> = Promise.resolve();
	rl.on("line", (line: string) => {
		queue = queue.then(() => {
			const text = line.trim();
			if (text === "") return;
			let request: { id?: unknown; cmd?: unknown; patch?: unknown };
			try {
				request = JSON.parse(text);
			} catch (error) {
				process.stdout.write(JSON.stringify({ id: null, ok: false, error: "请求不是 JSON" }) + "\n");
				return;
			}
			const payload = handle(String(request.cmd ?? "get"), request.patch as Record<string, unknown> | undefined, file);
			process.stdout.write(JSON.stringify({ id: request.id ?? null, ...payload }) + "\n");
		});
	});
	rl.on("close", () => {
		void queue.then(() => process.exit(0));
	});
} else if (command === "get") {
	const payload = readAll(file);
	process.stdout.write(JSON.stringify(payload, null, options.json ? 1 : 0) + "\n");
	if (!payload.ok) process.exitCode = 1;
} else if (command === "save") {
	const raw = options.file ? readFileSync(options.file, "utf8") : "";
	let patch: unknown;
	try {
		patch = JSON.parse(raw);
	} catch (error) {
		process.stdout.write(JSON.stringify({ ok: false, error: "补丁不是 JSON" }) + "\n");
		process.exit(1);
	}
	const payload = saveAll(file, patch);
	process.stdout.write(JSON.stringify(payload, null, 1) + "\n");
	if (!payload.ok) process.exitCode = 1;
} else {
	process.stderr.write("用法：review-rules-cli get|save --file <json>|serve [--path <文件>]\n");
	process.exit(2);
}
