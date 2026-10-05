// scripts/flows-cli.ts — 审核流程的命令行桥（GUI 主进程用它读图、存改动）
// 跑法：node --experimental-strip-types scripts/flows-cli.ts <命令> [参数]
//
//   list [--dir <目录>]              列出流程与状态（谁在生效、有没有问题）
//   get <id> [--dir <目录>]          一条流程的图与源码（GUI 选中时取）
//   save <id> --file <路径> [--dir]  存源码：先过越界检查，再写盘，然后回报校验结果
//   serve [--dir <目录>]             常驻：stdin 一行一个请求，输出一行一个 JSON
//
// 协议与 review-settings-cli 一致：请求 {"id":…,"cmd":"list|get|save","patch":{…}}，
// 响应是同一形状的 payload，带上回显的 id。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flowsDir, loadFlowFile, loadKitExtra } from "../lib/review-flow/load.ts";
import { inspectFlows } from "../lib/review-flow/inspect.ts";
import { checkFlowSource, formatViolations } from "../lib/review-flow/source-guard.ts";

interface Options { dir: string; json: boolean; file?: string }

function parseArgs(argv: string[]): { command: string; id?: string; options: Options } {
	const options: Options = { dir: flowsDir(), json: false };
	let command = "";
	let id: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--dir") { options.dir = argv[++index] ?? options.dir; continue; }
		if (arg === "--file") { options.file = argv[++index]; continue; }
		if (arg === "--json") { options.json = true; continue; }
		if (command === "") { command = arg; continue; }
		if (id === undefined && (command === "get" || command === "save")) { id = arg; continue; }
	}
	return { command, ...(id ? { id } : {}), options };
}

/** 列表：只给摘要，图另外取（图可能不小） */
async function listPayload(dir: string) {
	const flows = await inspectFlows(dir);
	return {
		flows: flows.map((item) => ({
			id: item.id,
			active: item.active,
			...(item.source ? { source: item.source } : {}),
			builtin: item.builtin,
			problems: item.problems,
			nodes: item.graph?.nodes.length ?? 0,
			edges: item.graph?.edges.length ?? 0,
		})),
		dir,
	};
}

/** 一条流程：图 + 源码（有的话） */
async function getPayload(dir: string, id: string) {
	const item = (await inspectFlows(dir)).find((flow) => flow.id === id);
	if (!item) return { ok: false, error: `没有这条流程：${id}` };
	let source: string | undefined;
	if (item.source) {
		try {
			source = readFileSync(item.source, "utf8");
		} catch {
			source = undefined;
		}
	}
	return {
		ok: true,
		flow: {
			id: item.id,
			active: item.active,
			...(item.source ? { source: item.source } : {}),
			...(source !== undefined ? { sourceText: source } : {}),
			builtin: item.builtin,
			problems: item.problems,
			...(item.graph ? { graph: item.graph } : {}),
		},
	};
}

/** 存源码：先越界检查，再写盘，最后把校验结果回报（坏文件不退，人自己看） */
async function savePayload(dir: string, id: string, content?: string) {
	if (content === undefined) return { ok: false, error: "save 需要内容（--file 或 patch.content）" };
	const path = join(dir, `${id}.ts`);
	const violations = await checkFlowSource(content, path);
	if (violations.length > 0) return { ok: false, error: formatViolations(violations, path) };
	writeFileSync(path, content, { mode: 0o600 });
	const { kit } = await loadKitExtra(dir);
	const loaded = await loadFlowFile(id, path, kit);
	return { ok: true, path, problems: "error" in loaded ? [loaded.error] : [] };
}

async function handleRequest(cmd: string, patch: Record<string, unknown> | undefined, dir: string) {
	if (cmd === "list") return listPayload(dir);
	if (cmd === "get") {
		const id = typeof patch?.id === "string" ? patch.id : undefined;
		if (!id) return { ok: false, error: "get 需要 id" };
		return getPayload(dir, id);
	}
	if (cmd === "save") {
		const id = typeof patch?.id === "string" ? patch.id : undefined;
		const content = typeof patch?.content === "string" ? patch.content : undefined;
		if (!id) return { ok: false, error: "save 需要 id" };
		return savePayload(dir, id, content);
	}
	return { ok: false, error: `不认识的命令：${cmd}` };
}

function readStdin(): Promise<string> {
	return new Promise((resolve) => {
		let buffer = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => { buffer += chunk; });
		process.stdin.on("end", () => resolve(buffer));
	});
}

async function respondToLine(line: string, dir: string): Promise<void> {
	let request: { id?: unknown; cmd?: unknown; patch?: unknown };
	try {
		request = JSON.parse(line) as { id?: unknown; cmd?: unknown; patch?: unknown };
	} catch (error) {
		process.stdout.write(JSON.stringify({ ok: false, error: "请求不是合法 JSON" }) + "\n");
		return;
	}
	const payload = await handleRequest(typeof request.cmd === "string" ? request.cmd : "", request.patch as Record<string, unknown> | undefined, dir);
	if (request.id !== undefined) (payload as Record<string, unknown>).id = request.id;
	process.stdout.write(JSON.stringify(payload) + "\n");
}

function serveStdio(dir: string): void {
	process.stdin.setEncoding("utf8");
	let buffer = "";
	// 串行处理：并发跑会让响应顺序跟请求对不上（谁先跑完谁先出），
	// GUI 那边虽然按 id 认，但顺序乱了排障时难看。一条一条来。
	let chain: Promise<void> = Promise.resolve();
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		let cut = buffer.indexOf("\n");
		while (cut >= 0) {
			const line = buffer.slice(0, cut).trim();
			buffer = buffer.slice(cut + 1);
			if (line !== "") chain = chain.then(() => respondToLine(line, dir));
			cut = buffer.indexOf("\n");
		}
	});
	process.stdin.on("end", () => process.exit(0));
}

async function main(): Promise<void> {
	const { command, id, options } = parseArgs(process.argv.slice(2));
	if (command === "serve") { serveStdio(options.dir); return; }
	if (command === "list") { process.stdout.write(JSON.stringify(await listPayload(options.dir), null, 1) + "\n"); return; }
	if (command === "get" && id) { process.stdout.write(JSON.stringify(await getPayload(options.dir, id), null, 1) + "\n"); return; }
	if (command === "save" && id) {
		const content = options.file ? readFileSync(options.file, "utf8") : await readStdin();
		const result = await savePayload(options.dir, id, content);
		process.stdout.write(JSON.stringify(result, null, 1) + "\n");
		if (!result.ok) process.exitCode = 1;
		return;
	}
	process.stderr.write("用法：flows-cli list|get <id>|save <id> --file <路径>|serve [--dir <目录>] [--json]\n");
	process.exitCode = 2;
}

void main();
