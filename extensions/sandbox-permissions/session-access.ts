// session-access.ts — 当前 session 的临时可写根与信任根
//
// 持久 allowDirs 仍保存在 sandbox-paths.json；本模块只保存当前进程/session 状态：
//   - sessionWriteDirs：普通 bash 可写；同样计入 sandbox-allow 免审批判定
//   - sessionTrustedDirs：普通 bash 可写，sandbox-allow 的 write-paths 可免审批（writeDirs 的子集）
//
// 不写盘。session ID 变化时自动清空，避免切换/恢复 session 泄漏授权。

import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";

interface SessionAccessState {
	sessionId: string | undefined;
	writeDirs: Set<string>;
	trustedDirs: Set<string>;
}

const GLOBAL_KEY = Symbol.for("pi.sandbox-permissions.session-access");
const globalState = globalThis as typeof globalThis & { [GLOBAL_KEY]?: SessionAccessState };
const state = globalState[GLOBAL_KEY] ?? {
	sessionId: undefined,
	writeDirs: new Set<string>(),
	trustedDirs: new Set<string>(),
};
globalState[GLOBAL_KEY] = state;

function ensureSession(sessionId: string | undefined): void {
	if (!sessionId || state.sessionId === sessionId) return;
	state.sessionId = sessionId;
	state.writeDirs.clear();
	state.trustedDirs.clear();
}

/** 在 session_start 或使用前同步当前 session；session 变化时清空临时授权。 */
export function beginSandboxSession(sessionId: string | undefined): void {
	ensureSession(sessionId);
}

/** session 结束/重载时清空临时授权，避免授权留给下一会话。 */
export function endSandboxSession(): void {
	state.sessionId = undefined;
	state.writeDirs.clear();
	state.trustedDirs.clear();
}

/** 路径规范化；拒绝根目录，避免临时授权等价于关闭沙箱。 */
export function normalizeSandboxRoot(path: string, cwd = process.cwd()): string | undefined {
	if (typeof path !== "string") return undefined;
	const text = path.trim();
	if (!text) return undefined;
	const expanded = text === "~"
		? homedir()
		: text.startsWith("~/")
			? `${homedir()}/${text.slice(2)}`
			: text;
	const absolute = normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
	if (absolute === "/" || absolute === ".") return undefined;
	return absolute;
}

export function normalizeSandboxRoots(paths: Iterable<string> | undefined, cwd = process.cwd()): string[] {
	const result = new Set<string>();
	for (const path of paths ?? []) {
		const normalized = normalizeSandboxRoot(path, cwd);
		if (normalized) result.add(normalized);
	}
	return [...result];
}

export function addSessionWriteDirs(paths: Iterable<string>, cwd = process.cwd()): string[] {
	const added: string[] = [];
	for (const path of normalizeSandboxRoots(paths, cwd)) {
		if (!state.writeDirs.has(path)) {
			state.writeDirs.add(path);
			added.push(path);
		}
	}
	return added;
}

export function addSessionTrustedDirs(paths: Iterable<string>, cwd = process.cwd()): string[] {
	const added: string[] = [];
	for (const path of normalizeSandboxRoots(paths, cwd)) {
		if (!state.trustedDirs.has(path)) added.push(path);
		state.trustedDirs.add(path);
		state.writeDirs.add(path);
	}
	return added;
}

export function getSessionWriteDirs(sessionId?: string): string[] {
	if (!sessionId || state.sessionId !== sessionId) return [];
	return [...state.writeDirs].sort();
}

export function getSessionTrustedDirs(sessionId?: string): string[] {
	if (!sessionId || state.sessionId !== sessionId) return [];
	return [...state.trustedDirs].sort();
}

export interface SessionAccessSnapshot {
	writeDirs: string[];
	trustedDirs: string[];
}

export function getSessionAccessSnapshot(sessionId?: string): SessionAccessSnapshot {
	return {
		writeDirs: getSessionWriteDirs(sessionId),
		trustedDirs: getSessionTrustedDirs(sessionId),
	};
}

export function isSessionTrustedPath(path: string, sessionId: string | undefined, cwd = process.cwd()): boolean {
	const normalized = normalizeSandboxRoot(path, cwd);
	return normalized !== undefined && pathsCoveredByRoots([normalized], getSessionTrustedDirs(sessionId), cwd);
}

function isInside(path: string, root: string): boolean {
	return path === root || path.startsWith(root + "/");
}

export function pathsCoveredByRoots(paths: Iterable<string>, roots: Iterable<string>, cwd = process.cwd()): boolean {
	const normalizedRoots = normalizeSandboxRoots(roots, cwd);
	return [...paths].every((path) => {
		const normalized = normalizeSandboxRoot(path, cwd);
		return normalized !== undefined && normalizedRoots.some((root) => isInside(normalized, root));
	});
}

/** 把当前 session 的普通可写根叠加进 shell 子进程环境，不覆盖已有额外根。 */
export function addSessionWriteDirsToEnv(env: NodeJS.ProcessEnv | undefined, sessionId?: string): NodeJS.ProcessEnv {
	const base = env ?? process.env;
	const dirs = getSessionWriteDirs(sessionId);
	if (dirs.length === 0) return { ...base };
	const existing = (base.PI_SANDBOX_RW_EXTRA ?? "").split(":").filter(Boolean);
	const merged = [...new Set([...existing, ...dirs])];
	return { ...base, PI_SANDBOX_RW_EXTRA: merged.join(":") };
}

/** 测试/会话切换用；不持久化，也不触碰长期 allowDirs。 */
export function resetSandboxSessionForTest(sessionId = "test-session"): void {
	state.sessionId = sessionId;
	state.writeDirs.clear();
	state.trustedDirs.clear();
}
