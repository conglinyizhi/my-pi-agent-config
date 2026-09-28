// trusted.ts — 人类确认过的「可信程序目录」
//
// 这些目录下**自己编译/自己维护**的可执行文件，按「已知程序」对待：不再被当成
// 「home 下的未知二进制」送进预审，也就不再因为「程序是谁编译的」这一条被拦。
//
// ⚠️ 这份名单会**放宽 AI 命令的审核**，所以它是**人类的权限**：
//   - 只把人类自己确认过、或人类自己编译出来的产物写进来；
//     编译这类文件的过程不该让大模型代劳 —— 那等于让被审核的一方自己发通行证
//   - 大模型不得代填：模型物理上能改这个文件，改它却等于给自己放宽审核。
//     代码与文档里都写明这一点，是为了让每次「顺手加一条」都先停下来想一想
//   - 默认空：不配就一切照旧（home 下的二进制照旧按未知程序报）
//
// 存储上它与 allowDirs 同在一个文件（sandbox-paths.json 的 trustedProgramDirs），
// 但语义完全不同：allowDirs 管「写哪些目录不用逐次审批」，这份管「哪个程序算已知」。
// 前者放宽的是路径，后者放宽的是程序可信度，混着改容易一次放开两样。
//
// 这一层单独成模块的理由：rule-engine.ts 是最底层，paths.ts 反过来依赖它，
// 所以配置读取不能放进任何一边 —— 放这里，两个方向都能用，不成环。
//
// 写入点分两处、口径一致：本模块的 add/removeTrustedProgramDir（/sandbox:paths 走这里）
// 与 paths.ts 的 saveSandboxPaths（改 allowDirs/blockDirs）。**两边都只改自己那几个键**，
// 其它顶层字段原样保留 —— 否则「加一条 allowDirs」会把 trustedProgramDirs 抹掉。

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let pathsFile = join(getAgentDir(), "extensions", "sandbox-permissions", "sandbox-paths.json");

/**
 * 缓存按**文件 mtime + size**失效（口径对齐 extensions/repo-prompts/content.ts 的 readTextCached）。
 *
 * 早先的实现是「读过一次就永远用内存那份」：改完名单得 /reload 才认。可这份名单的写入点
 * （/sandbox:paths 命令、手改文件）就发生在本进程里，读一次锁死等于写入不生效。
 * 现在每次 stat 一次：mtimeMs 与 size 都没变才用缓存；变了（哪怕字节数一样）就重读。
 * 文件读不到 = 空名单（保守方向：不认得就照旧报），并且不保留旧缓存。
 *
 * 代价是每次判定多一次 stat。isTrustedProgramPath 在审核链上会被调用若干次，
 * statSync 很便宜（微秒级），比「读到过期名单」划算得多。
 */
interface CacheEntry {
	mtimeMs: number;
	size: number;
	dirs: string[];
}

let cache: CacheEntry | undefined;

/** 诊断/测试用计数器：真实读盘次数与缓存命中次数 */
let readCount = 0;
let hitCount = 0;

/**
 * 目录规范化：与 paths.ts 的 normalizeDir 同口径（trim、展开 ~、消 ..、去尾斜杠）。
 * 这里不 import 它——那会把底层模块拽回上层；两处口径要一起看。
 */
function normalizeDir(dir: string): string {
	let d = (dir ?? "").trim();
	if (!d) return "";
	if (d === "~") d = homedir();
	if (d.startsWith("~/")) d = join(homedir(), d.slice(2));
	d = normalize(d);
	if (!d.startsWith("/")) d = resolve(d);
	while (d.length > 1 && d.endsWith("/")) d = d.slice(0, -1);
	return d;
}

/** 解析配置文本里的 trustedProgramDirs（缺字段 / 坏 JSON 一律当空） */
function parseTrusted(text: string): string[] {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return [];
	}
	const list = (raw as { trustedProgramDirs?: unknown })?.trustedProgramDirs;
	return Array.isArray(list)
		? list.filter((d): d is string => typeof d === "string").map(normalizeDir).filter(Boolean)
		: [];
}

/** 读配置里的可信程序目录（缺字段、坏 JSON、文件不存在一律当空） */
export function loadTrustedProgramDirs(): string[] {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(pathsFile);
	} catch {
		cache = undefined;
		return [];
	}
	if (!stat.isFile()) {
		cache = undefined;
		return [];
	}

	if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
		hitCount++;
		return cache.dirs;
	}

	readCount++;
	let dirs: string[];
	try {
		dirs = parseTrusted(readFileSync(pathsFile, "utf8"));
	} catch {
		// stat 过了但读失败（权限/竞态）：不缓存半成品，按空处理
		cache = undefined;
		return [];
	}
	cache = { mtimeMs: stat.mtimeMs, size: stat.size, dirs };
	return dirs;
}

/**
 * 这个值是不是落在可信程序目录里。
 *
 * 只看前缀，且只认**目录边界**：`/opt/tools` 不该把 `/opt/tools-evil/x` 算进去，
 * 所以要求命中值等于该目录或紧接一个 `/`。目录本身按 normalizeDir 规范化后比较。
 */
export function isTrustedProgramPath(value: string): boolean {
	if (!value) return false;
	const target = normalizeDir(value);
	for (const dir of loadTrustedProgramDirs()) {
		if (target === dir || target.startsWith(`${dir}/`)) return true;
	}
	return false;
}

// ═══════════════════════════════════════════════════
// 写入（人类权限：只由人类的动作驱动，见文件头）
// ═══════════════════════════════════════════════════

/** 读整个配置文件（保留 allowDirs/blockDirs 等其它字段）；坏 JSON / 不存在 → {} */
function readDoc(): Record<string, unknown> {
	try {
		const raw: unknown = JSON.parse(readFileSync(pathsFile, "utf8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			return { ...(raw as Record<string, unknown>) };
		}
	} catch {
		// 坏 JSON：整份当空重建，不猜内容
	}
	return {};
}

function writeTrustedDirs(dirs: string[]): void {
	const doc = readDoc();
	doc.trustedProgramDirs = dirs;
	writeFileSync(pathsFile, JSON.stringify(doc, null, 2) + "\n", "utf8");
	// 落盘后下一次读取必须重新 stat：清掉旧条目，避免 mtime 粒度导致的假命中
	cache = undefined;
}

/** 追加一个可信程序目录（规范化、去重）；返回是否真的新增 */
export function addTrustedProgramDir(dir: string): boolean {
	const d = normalizeDir(dir);
	if (!d || d === "/") return false;
	const dirs = loadTrustedProgramDirs();
	if (dirs.includes(d)) return false;
	writeTrustedDirs([...dirs, d]);
	return true;
}

/** 移除一个可信程序目录；不存在返回 false */
export function removeTrustedProgramDir(dir: string): boolean {
	const d = normalizeDir(dir);
	if (!d || d === "/") return false;
	const dirs = loadTrustedProgramDirs();
	const next = dirs.filter((x) => x !== d);
	if (next.length === dirs.length) return false;
	writeTrustedDirs(next);
	return true;
}

/** 仅供测试：换配置文件并清缓存 */
export function setTrustedProgramsFile(file: string): void {
	pathsFile = file;
	cache = undefined;
}

/** 仅供测试：清缓存（并复位计数器） */
export function resetTrustedCache(): void {
	cache = undefined;
	readCount = 0;
	hitCount = 0;
}

/** 诊断/测试：真实读盘次数、缓存命中次数、当前是否有缓存条目 */
export function trustedCacheStats(): { reads: number; hits: number; cached: boolean } {
	return { reads: readCount, hits: hitCount, cached: cache !== undefined };
}
