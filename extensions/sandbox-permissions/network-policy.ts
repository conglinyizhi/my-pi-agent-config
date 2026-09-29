// network-policy.ts — worker 的 network 审核强度（人类可调的三档）
//
// 背景：主 agent 的 bash 从不卡 network（checkCommand 里没有网络规则），只有 worker 侧
// 有一道门（capability request）。那道门的松紧跟环境关系很大：在自家工作机上「限制网络」
// 几乎没有价值，可 worker 每次出网都要问一次人。这里把松紧做成档位，由人类自己调。
//
// 三档（network-policy.json 的 mode）：
//   off        网络不算能力：worker 不发请求、不留痕，出网等同普通操作
//   whitelist  现状：仅「可枚举的开发期拉取」且形态干净的命令免问，其余交审核链
//   loose      只拦「往外送数据 / 拿回来就执行 / 判不出来的动态构造」，其余直接批准
//
// 命令维度不受档位影响：checkCommand 判出风险（allow=false）时永远走审核链（预审 + 按需问人）。
// publish 类（git push / 包发布）也不在 network 分类里，worker 直接拒收，与档位无关。
//
// ⚠️ 这份配置会放宽 AI 命令的审核（off/loose 尤甚），所以它是**人类的权限**：
//    只由人类用 /sandbox:network 或手改文件来设，模型不得代填 —— 模型改它等于
//    被审核的一方给自己发通行证（与 trusted.ts 的同一条规矩）。
//
// 存储：extensions/sandbox-permissions/network-policy.json（本机配置，已 gitignore）。
// 文件缺失 / 坏 JSON / 未知取值一律当 whitelist：接入前的行为就是 whitelist，缺配置不该变松。
//
// 判定只有这一份实现：worker 侧当快路用（判到放行就不发请求），父进程当权威
// （同一函数 + 审计）。两边读的是同一个文件，按 mtime + size 失效。

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { splitCommands } from "./rule-engine.ts";
import { requestedCapability } from "../../lib/subagent-capability.ts";

export type NetworkMode = "off" | "whitelist" | "loose";

/** 三档的元数据：GUI / 用法文案 / 错误提示共用（顺序即窗口里的顺序） */
export interface NetworkModeMeta {
	mode: NetworkMode;
	/** 窗口第一列（也是命令行里写的词） */
	label: string;
	/** 一句话说明 */
	summary: string;
	/** 展开的要点（确认框正文） */
	points: string[];
}

export const NETWORK_MODES: NetworkModeMeta[] = [
	{
		mode: "off",
		label: "off",
		summary: "关闭网络审核：出网等同普通操作，不发请求、不留痕",
		points: [
			"worker 不再为出网发 capability 请求（快路直接放行）",
			"网络这一维不留审计记录",
			"命令本身的风险（rm -rf、内联脚本…）照旧走审核链",
		],
	},
	{
		mode: "whitelist",
		label: "whitelist",
		summary: "现状：只免审可枚举的开发期拉取，其余出网交审核链",
		points: [
			"免审集合（连请求都不发）：包管理器 install/add/update/remove/ci、git clone/fetch/pull、不带落盘与提交参数的 curl/wget",
			"集合外的出网命令先过 LLM 预审，判 safe 自动放行，否则问人",
			"这是接入档位之前的行为，缺配置文件时的默认档",
		],
	},
	{
		mode: "loose",
		label: "loose",
		summary: "宽松：只拦往外送数据、拿回来就执行、动态构造这三类",
		points: [
			"仍要人点头：上传/提交数据（-d/-F/-T、非 GET）、下载后执行（管道进解释器、落盘后跑脚本）",
			"仍要人点头：出网段含变量或命令替换，静态判不出来时不放过",
			"其余直接批准，包括 -o 落盘、cd x && pnpm install 这类多段拼接",
			"每条出网命令都由父进程判定并留审计记录（与 off 的差别就在这条）",
		],
	},
];

export function networkModeMeta(mode: NetworkMode): NetworkModeMeta {
	return NETWORK_MODES.find((m) => m.mode === mode) ?? NETWORK_MODES[1]!;
}

/** 档位词（命令行与 TUI 提示用） */
export const NETWORK_MODE_WORDS = NETWORK_MODES.map((m) => m.label).join(" | ");

/** 解析档位词：接受完整词，不接受缩写（缩写会让人以为自己调了别的档） */
export function parseNetworkMode(word: string): NetworkMode | undefined {
	const w = word.trim().toLowerCase();
	return NETWORK_MODES.find((m) => m.mode === w)?.mode;
}

// ═══════════════════════════════════════════════════
// 配置读写
// ═══════════════════════════════════════════════════

let policyFile = join(getAgentDir(), "extensions", "sandbox-permissions", "network-policy.json");

export function networkPolicyFile(): string {
	return policyFile;
}

/** 测试用：指向临时文件（真实路径不吃测试的写盘） */
export function setNetworkPolicyFileForTest(file: string): void {
	policyFile = file;
	cache = undefined;
}

interface CacheEntry {
	mtimeMs: number;
	size: number;
	mode: NetworkMode;
}

let cache: CacheEntry | undefined;

/** 从配置文本里取档位；缺失/坏 JSON/未知取值一律 whitelist（保守方向） */
export function parseNetworkPolicy(text: string): NetworkMode {
	try {
		return parseNetworkMode(String((JSON.parse(text) as { mode?: unknown })?.mode ?? "")) ?? "whitelist";
	} catch {
		return "whitelist";
	}
}

/** 当前档位（按 mtime + size 失效，口径同 paths.ts / trusted.ts） */
export function loadNetworkMode(): NetworkMode {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(policyFile);
	} catch {
		cache = undefined;
		return "whitelist";
	}
	if (!stat.isFile()) {
		cache = undefined;
		return "whitelist";
	}
	if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.mode;

	let mode: NetworkMode;
	try {
		mode = parseNetworkPolicy(readFileSync(policyFile, "utf8"));
	} catch {
		// stat 过了但读失败（权限/竞态）：不缓存半成品，按默认档
		cache = undefined;
		return "whitelist";
	}
	cache = { mtimeMs: stat.mtimeMs, size: stat.size, mode };
	return mode;
}

/** 写档位：只写 mode 这一个键，其它顶层字段原样保留 */
export function saveNetworkMode(mode: NetworkMode): void {
	let existing: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(policyFile, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
	} catch {
		/* 文件不存在或坏 JSON：从空对象起写 */
	}
	const next = { ...existing, mode };
	writeFileSync(policyFile, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	cache = undefined;
}

// ═══════════════════════════════════════════════════
// 命令形态判定（纯函数）
// ═══════════════════════════════════════════════════

/**
 * 这些字符/构造让「这段命令在做什么」无法静态确定：多段拼接、管道、重定向、
 * 命令替换、变量。whitelist 档拿它当门槛 —— 与接入档位之前那条单段静态白名单同口径。
 */
const SHELL_METACHAR_RE = /(?:&&|\|\||[;|`<>\n]|\$(?:[A-Za-z_]|\{|\())/;

/** 词法切分（与 rule-engine 同口径：引号内保留为一个 token，去引号） */
function tokensOf(text: string): string[] {
	const tokens = text.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g);
	if (!tokens?.length) return [];
	return tokens.map((t) => t.replace(/^(?:"|')|(?:"|')$/g, ""));
}

/** 段内的命令名与参数（跳过开头的 NAME=value 环境变量前缀） */
function invocationOf(tokens: string[]): { executable: string; rest: string[] } | undefined {
	let index = 0;
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++;
	const raw = tokens[index];
	if (!raw) return undefined;
	const executable = (raw.split("/").pop() ?? "").toLowerCase();
	return executable ? { executable, rest: tokens.slice(index + 1) } : undefined;
}

/** 会执行输入的段：解释器本体 + 交给解释器的脚本文件 */
const INTERPRETER_EXECUTABLES = new Set([
	"sh", "bash", "zsh", "dash", "ksh", "eval",
	"python", "python2", "python3", "node", "nodejs", "deno", "bun",
	"perl", "ruby", "php", "lua",
]);
const SCRIPT_SUFFIX_RE = /\.(?:sh|bash|zsh|ksh|dash|py|py3|rb|pl|php|lua|js|mjs|cjs|ts)$/i;

/** 会往外送数据 / 改变请求语义的参数（curl 与 wget 两套写法） */
const UPLOAD_ARGS = [
	"-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
	"-F", "--form", "-T", "--upload-file",
	"--post-data", "--post-file", "--body-data", "--body-file",
];
/** 明确落盘（下载后执行的另一半） */
const WRITE_ARGS = ["-o", "-O", "--output", "--output-document", "--remote-name"];

/** 请求方法被显式改掉：`-X POST` / `--request=POST` / `--method=PUT`。GET 不算改变。 */
function changesRequestMethod(tokens: string[], index: number): boolean {
	const token = tokens[index] ?? "";
	const inline = /^(?:--request|--method)=(.+)$/i.exec(token)?.[1];
	const value = (inline ?? tokens[index + 1] ?? "").trim().toUpperCase();
	return value !== "" && value !== "GET";
}

function isMethodFlag(token: string): boolean {
	return token === "-X" || /^(?:--request|--method)(?:=|$)/i.test(token);
}

/** 参数命中（含 `--flag=value` 写法） */
function inArgList(token: string, list: readonly string[]): boolean {
	return list.includes(token) || list.some((flag) => token.startsWith(`${flag}=`));
}

/** 管道右边直接是解释器：`curl … | sh`。分段丢掉了分隔符，这条只能从原文认。 */
const PIPE_TO_INTERPRETER_RE = /\|\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:sudo\s+)?(?:[\w./-]*\/)?(?:sh|bash|zsh|dash|ksh|eval|python[0-9.]*|node|deno|bun|perl|ruby|php|lua)\b/i;

/**
 * 「可枚举的开发期拉取」：单段、无 shell 元字符、命令名与子命令在白名单里。
 *
 * 返回一个标签（进审计与展示），不是则 undefined。规则与接入档位之前的
 * isWorkerNetworkAutoApproved 完全一致 —— whitelist 档就是靠这个保持现状。
 */
export function staticNetworkInvocation(command: string): string | undefined {
	const text = command.trim();
	if (!text || SHELL_METACHAR_RE.test(text)) return undefined;
	const invocation = invocationOf(tokensOf(text));
	if (!invocation) return undefined;
	const { executable, rest } = invocation;

	// 远端写入/发布永远不属于可自动放行集合（调用方分类漏了也要在这里二次卡住）
	if (/\b(?:publish|push)\b/i.test(rest.join(" "))) return undefined;

	if (["pnpm", "npm", "yarn", "bun"].includes(executable)) {
		const sub = (rest[0] ?? "").toLowerCase();
		return ["install", "add", "update", "remove", "ci"].includes(sub) ? `${executable} ${sub}` : undefined;
	}
	if (["uv", "pip", "pip3", "poetry", "go", "cargo"].includes(executable)) {
		const operation = executable === "uv"
			? `${rest[0] ?? ""} ${rest[1] ?? ""}`.trim().toLowerCase()
			: (rest[0] ?? "").toLowerCase();
		return ["pip install", "install", "add", "update", "get", "fetch"].includes(operation)
			? `${executable} ${operation}`
			: undefined;
	}
	if (executable === "git") {
		const sub = (rest[0] ?? "").toLowerCase();
		if (["clone", "fetch", "pull"].includes(sub)) return `git ${sub}`;
		if (sub === "submodule" && ["add", "update"].includes((rest[1] ?? "").toLowerCase())) return `git submodule ${rest[1]}`;
		return undefined;
	}
	if (executable === "curl" || executable === "wget") {
		// 落盘、提交数据、非 GET 都留给人工/预审兜底；只允许读到 stdout
		const risky = rest.some((arg, i) =>
			inArgList(arg, UPLOAD_ARGS) || inArgList(arg, WRITE_ARGS) ||
			(isMethodFlag(arg) && changesRequestMethod(rest, i)),
		);
		return risky ? undefined : executable;
	}
	return undefined;
}

/** 这条命令里哪些段是「出网段」（按 requestedCapability 的分类） */
function networkSegments(command: string): string[][] {
	return splitCommands(command).filter((seg) => {
		const text = seg.join(" ");
		return requestedCapability(text)?.capability === "network";
	});
}

/**
 * loose 档要拦的形态；干净返回 undefined，命中返回一句人话。
 *
 * 拦三类（其余放行，含 -o 落盘与多段拼接）：
 *   1. 往外送数据：上传/提交参数、非 GET
 *   2. 拿回来就执行：管道进解释器，或「网络段落盘 + 命令里还有解释器/脚本段」
 *   3. 判不出来的动态构造：出网段含变量，或整条命令含命令替换/反引号
 */
export function riskyNetworkShape(command: string): string | undefined {
	const segments = splitCommands(command);
	const network = segments.filter((seg) => requestedCapability(seg.join(" "))?.capability === "network");
	if (network.length === 0) return undefined;

	// 3. 动态构造：$( ) 与反引号能让任何静态判定失效
	if (/\$\(|`/.test(command)) return "命令里含命令替换或反引号，静态判不出来";

	for (const seg of network) {
		for (const [i, token] of seg.entries()) {
			if (inArgList(token, UPLOAD_ARGS)) return `出网命令带 ${token}，会往外送数据`;
			if (isMethodFlag(token) && changesRequestMethod(seg, i)) {
				return `出网命令把请求方法改成了 ${(seg[i + 1] ?? "").toUpperCase()}`;
			}
			if (token.includes("$")) return `出网命令的目标含变量（${token}），静态判不出来`;
		}
	}

	// 2. 拿回来就执行：管道形式一条就够；落盘形式要「网络段确实写了文件 + 另有解释器/脚本段」
	if (PIPE_TO_INTERPRETER_RE.test(command)) return "出网结果直接进解释器（管道）";
	const writesFiles = network.some((seg) => seg.some((token) => inArgList(token, WRITE_ARGS) || token.startsWith(">")));
	if (writesFiles) {
		for (const seg of segments) {
			const invocation = invocationOf(seg);
			if (!invocation) continue;
			if (INTERPRETER_EXECUTABLES.has(invocation.executable) || SCRIPT_SUFFIX_RE.test(invocation.executable)) {
				return `出网结果落盘后被执行（${invocation.executable}）`;
			}
		}
	}
	return undefined;
}

export interface NetworkDecision {
	/** true = network 这一维直接放行（不发请求、不必预审、不必问人） */
	allow: boolean;
	/** 给审计与展示的一句话 */
	reason: string;
}

/**
 * 按档位判定一条命令的 network 维度。只回答「网络这一维要不要人管」，
 * 不回答命令本身危不危险 —— 那是 checkCommand + 审核链的事。
 */
export function decideNetwork(command: string, mode: NetworkMode = loadNetworkMode()): NetworkDecision {
	if (mode === "off") {
		return { allow: true, reason: "network 审核档位为 off：网络不算能力" };
	}
	if (mode === "loose") {
		const shape = riskyNetworkShape(command);
		return shape
			? { allow: false, reason: `loose 档下仍要人看：${shape}` }
			: { allow: true, reason: "loose 档：出网形态干净，直接批准" };
	}
	const label = staticNetworkInvocation(command);
	if (label) return { allow: true, reason: `whitelist 档：${label} 属开发期拉取，免问` };
	const shape = riskyNetworkShape(command);
	return { allow: false, reason: shape ? `出网命令需确认：${shape}` : "出网命令不在免审集合内，交审核链" };
}
