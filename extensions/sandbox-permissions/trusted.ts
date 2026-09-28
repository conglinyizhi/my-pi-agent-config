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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let pathsFile = join(getAgentDir(), "extensions", "sandbox-permissions", "sandbox-paths.json");

/** 规范化后缓存；读不到文件时等于空名单（保守方向：不认得就照旧报） */
let cache: string[] | undefined;

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

/** 读配置里的可信程序目录（缺字段、坏 JSON、文件不存在一律当空） */
export function loadTrustedProgramDirs(): string[] {
	if (cache) return cache;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(pathsFile, "utf8"));
	} catch {
		cache = [];
		return cache;
	}
	const list = (raw as { trustedProgramDirs?: unknown })?.trustedProgramDirs;
	cache = Array.isArray(list)
		? list.filter((d): d is string => typeof d === "string").map(normalizeDir).filter(Boolean)
		: [];
	return cache;
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

/** 仅供测试：换配置文件并清缓存 */
export function setTrustedProgramsFile(file: string): void {
	pathsFile = file;
	cache = undefined;
}

/** 仅供测试：清缓存（清内容不换引用） */
export function resetTrustedCache(): void {
	cache = undefined;
}
