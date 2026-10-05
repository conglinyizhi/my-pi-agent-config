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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flowsDir, loadFlowFile, loadKitExtra } from "../lib/review-flow/load.ts";
import { inspectFlows } from "../lib/review-flow/inspect.ts";
import { checkFlowSource, formatViolations } from "../lib/review-flow/source-guard.ts";
import { editEdgeInSource, type EdgeEditRequest } from "../lib/review-flow/edit-edge.ts";
import { addNodeToSource } from "../lib/review-flow/add-node.ts";
import { removeEdgeInSource } from "../lib/review-flow/edit-edge.ts";

interface Options {
	dir: string;
	json: boolean;
	file?: string;
	/** edit-edge 的四个参数（一次性回落时用命令行给，比塞 JSON 好读） */
	node?: string;
	kind?: string;
	label?: string;
	to?: string;
	/** add-node：插在谁前面、把谁的 next 接过来 */
	before?: string;
	connect?: string;
}

function parseArgs(argv: string[]): { command: string; id?: string; options: Options } {
	const options: Options = { dir: flowsDir(), json: false };
	let command = "";
	let id: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--dir") { options.dir = argv[++index] ?? options.dir; continue; }
		if (arg === "--file") { options.file = argv[++index]; continue; }
		if (arg === "--node") { options.node = argv[++index]; continue; }
		if (arg === "--kind") { options.kind = argv[++index]; continue; }
		if (arg === "--label") { options.label = argv[++index]; continue; }
		if (arg === "--to") { options.to = argv[++index]; continue; }
		if (arg === "--before") { options.before = argv[++index]; continue; }
		if (arg === "--connect") { options.connect = argv[++index]; continue; }
		if (arg === "--json") { options.json = true; continue; }
		if (command === "") { command = arg; continue; }
		if (id === undefined && ["get", "save", "edit-edge", "remove-edge", "add-node"].includes(command)) { id = arg; continue; }
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
	const path = await savePath(dir, id);
	if (typeof path !== "string") return { ok: false, error: path.error };
	const violations = await checkFlowSource(content, path);
	if (violations.length > 0) return { ok: false, error: formatViolations(violations, path) };
	writeFileSync(path, content, { mode: 0o600 });
	const { kit } = await loadKitExtra(dir);
	const loaded = await loadFlowFile(id, path, kit);
	return { ok: true, path, problems: "error" in loaded ? [loaded.error] : [] };
}

/**
 * 图上改一条边：定位到那个节点，只替换那一个字面量；写完再校验一遍。
 * 改动引入越界检查问题（理论上不该）就拒绝落盘。
 */
async function editEdgePayload(dir: string, id: string, patch: Record<string, unknown>) {
	const found = await flowFilePath(dir, id);
	if ("error" in found) return { ok: false, error: found.error };
	const path = found.path;
	const source = readFileSync(path, "utf8");
	const request: EdgeEditRequest = {
		source,
		fileName: path,
		nodeId: String(patch.nodeId ?? ""),
		kind: (patch.kind ?? "next") as EdgeEditRequest["kind"],
		...(typeof patch.label === "string" ? { label: patch.label } : {}),
		to: String(patch.to ?? ""),
	};
	const result = await editEdgeInSource(request);
	if (!result.ok) return { ok: false, error: result.error };
	if (!result.changed) return { ok: true, changed: false, problems: [] };
	const next = result.source ?? source;
	const violations = await checkFlowSource(next, path);
	if (violations.length > 0) return { ok: false, error: formatViolations(violations, path) };
	writeFileSync(path, next, { mode: 0o600 });
	const { kit } = await loadKitExtra(dir);
	const loaded = await loadFlowFile(id, path, kit);
	return { ok: true, changed: true, problems: "error" in loaded ? [loaded.error] : [] };
}

/**
 * 往流程里加一个节点：定点插入，可选把一条既有边改接到它，然后整份重新校验。
 * 与 save / edit-edge 同一条纪律：宁可整段不动，也不落一份校验不过的源码。
 */
async function addNodePayload(dir: string, id: string, patch: Record<string, unknown>) {
	const found = await flowFilePath(dir, id);
	if ("error" in found) return { ok: false, error: found.error };
	const path = found.path;
	const source = readFileSync(path, "utf8");
	const connect = patch.connect as { nodeId?: unknown; kind?: unknown; label?: unknown } | undefined;
	const result = await addNodeToSource({
		source,
		fileName: path,
		id: String(patch.nodeId ?? ""),
		kind: String(patch.kind ?? "custom"),
		...(typeof patch.before === "string" && patch.before !== "" ? { before: patch.before } : {}),
		...(connect && typeof connect.nodeId === "string"
			? {
				connect: {
					nodeId: connect.nodeId,
					edge: {
						kind: (connect.kind ?? "next") as EdgeEditRequest["kind"],
						...(typeof connect.label === "string" ? { label: connect.label } : {}),
					},
				},
			}
			: {}),
	});
	if (!result.ok) return { ok: false, error: result.error };
	const next = result.source ?? source;
	const violations = await checkFlowSource(next, path);
	if (violations.length > 0) return { ok: false, error: formatViolations(violations, path) };
	writeFileSync(path, next, { mode: 0o600 });
	const { kit } = await loadKitExtra(dir);
	const loaded = await loadFlowFile(id, path, kit);
	return { ok: true, changed: true, problems: "error" in loaded ? [loaded.error] : [] };
}

/**
 * 找这份流程的文件。
 * 内置流程（bash-pre 这些）没有文件，得说清楚；回一句"没有这份流程文件"会让人以为文件丢了（踩过）。
 */
function builtinRefusal(id: string): string {
	return `${id} 是内置流程（实现在 lib/review-flow/flows/ 里），没有可以就地改的文件。要改就照它新建一份自己的流程，改完在窗口里切过去`;
}

async function isBuiltinId(dir: string, id: string): Promise<boolean> {
	if (existsSync(join(dir, `${id}.ts`))) return false;
	const item = (await inspectFlows(dir)).find((flow) => flow.id === id);
	return item?.active === "builtin";
}

async function flowFilePath(dir: string, id: string): Promise<{ path: string } | { error: string }> {
	const path = join(dir, `${id}.ts`);
	if (existsSync(path)) return { path };
	if (await isBuiltinId(dir, id)) return { error: builtinRefusal(id) };
	return { error: `没有这份流程文件：${path}` };
}

/** 保存可以新建文件；只有内置流程那个 id 不让占，否则按一下保存就把内置的顶掉了 */
async function savePath(dir: string, id: string): Promise<string | { error: string }> {
	const path = join(dir, `${id}.ts`);
	if (existsSync(path)) return path;
	if (await isBuiltinId(dir, id)) return { error: builtinRefusal(id) };
	return path;
}

/** 删一条边：断开是合法中间态（先断再连），所以这里不拦校验，坏在哪图上自己看得见 */
async function removeEdgePayload(dir: string, id: string, patch: Record<string, unknown>) {
	const found = await flowFilePath(dir, id);
	if ("error" in found) return { ok: false, error: found.error };
	const path = found.path;
	const result = await removeEdgeInSource({
		source: readFileSync(path, "utf8"),
		fileName: path,
		nodeId: String(patch.nodeId ?? ""),
		kind: (patch.kind ?? "next") as EdgeEditRequest["kind"],
		...(typeof patch.label === "string" && patch.label !== "" ? { label: patch.label } : {}),
	});
	if (!result.ok) return { ok: false, error: result.error };
	if (result.changed) writeFileSync(path, result.source ?? "", { mode: 0o600 });
	return { ok: true, changed: result.changed === true };
}

async function handleRequest(cmd: string, patch: Record<string, unknown> | undefined, dir: string) {
	if (cmd === "list") return listPayload(dir);
	if (cmd === "get") {
		const id = typeof patch?.id === "string" ? patch.id : undefined;
		if (!id) return { ok: false, error: "get 需要 id" };
		return getPayload(dir, id);
	}
	if (cmd === "add-node") {
		const id = typeof patch?.id === "string" ? patch.id : undefined;
		if (!id) return { ok: false, error: "add-node 需要 id" };
		return addNodePayload(dir, id, patch ?? {});
	}
	if (cmd === "remove-edge") {
		const id = typeof patch?.id === "string" ? patch.id : undefined;
		if (!id) return { ok: false, error: "remove-edge 需要 id" };
		return removeEdgePayload(dir, id, patch ?? {});
	}
	if (cmd === "edit-edge") {
		const id = typeof patch?.id === "string" ? patch.id : undefined;
		if (!id) return { ok: false, error: "edit-edge 需要 id" };
		return editEdgePayload(dir, id, patch ?? {});
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
	if (command === "remove-edge" && id) {
		const result = await removeEdgePayload(options.dir, id, {
			nodeId: options.node ?? "",
			kind: options.kind ?? "next",
			...(options.label ? { label: options.label } : {}),
		});
		process.stdout.write(JSON.stringify(result, null, 1) + "\n");
		if (!result.ok) process.exitCode = 1;
		return;
	}
	if (command === "add-node" && id) {
		const result = await addNodePayload(options.dir, id, {
			nodeId: options.node ?? "",
			kind: options.kind ?? "custom",
			...(options.before ? { before: options.before } : {}),
			...(options.connect ? { connect: { nodeId: options.connect, kind: "next" } } : {}),
		});
		process.stdout.write(JSON.stringify(result, null, 1) + "\n");
		if (!result.ok) process.exitCode = 1;
		return;
	}
	if (command === "edit-edge" && id) {
		const result = await editEdgePayload(options.dir, id, {
			nodeId: options.node ?? "",
			kind: options.kind ?? "next",
			...(options.label ? { label: options.label } : {}),
			to: options.to ?? "",
		});
		process.stdout.write(JSON.stringify(result, null, 1) + "\n");
		if (!result.ok) process.exitCode = 1;
		return;
	}
	if (command === "save" && id) {
		const content = options.file ? readFileSync(options.file, "utf8") : await readStdin();
		const result = await savePayload(options.dir, id, content);
		process.stdout.write(JSON.stringify(result, null, 1) + "\n");
		if (!result.ok) process.exitCode = 1;
		return;
	}
	process.stderr.write("用法：flows-cli list|get <id>|save <id> --file <路径>|edit-edge <id> --node <节点> --kind <next|branch|error|timeout|empty> [--label <出口>] --to <目标>|serve [--dir <目录>]" + "\n");
	process.exitCode = 2;
}

void main();
