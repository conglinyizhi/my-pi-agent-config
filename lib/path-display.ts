// lib/path-display.ts — 把绝对路径缩成给人看的形态（~ / $PWD）
//
// 审脚本时"这个调用动的是哪个文件"全靠路径说话，而一屏里每行都顶着
// 同一段 /home/xxx/... 前缀，注意力就花在重复上。这里只做显示层缩短：
// 拿不准的一律原样返回，绝不猜。

export interface DisplayPathOptions {
	/** 家目录（调用方给 os.homedir()）；不给就不做 ~ 替换 */
	home?: string;
	/** 当前工作目录（调用方给 ctx.cwd）；不给就不做 $PWD 替换 */
	cwd?: string;
	/** 超过这个长度就中间省略（默认 64） */
	maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 64;

function stripTrailingSlash(path: string): string {
	return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * path 在 dir 之下时返回剩余部分（恰好是 dir 本身返回空串），否则 undefined。
 * 根目录不做前缀替换：把 /usr/bin/x 缩成 "//usr/bin/x" 这种既没变短也没多出信息。
 */
function under(path: string, dir: string): string | undefined {
	const base = stripTrailingSlash(dir);
	if (base === "" || base === "/") return undefined;
	if (path === base) return "";
	if (path.startsWith(base + "/")) return path.slice(base.length);
	return undefined;
}

/** 中间省略：留头留尾。文件名比父目录重要，所以尾巴留得比头多 */
export function ellipsizeMiddle(path: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
	if (maxLength < 8 || path.length <= maxLength) return path;
	const keepHead = Math.max(1, Math.floor((maxLength - 1) / 3));
	const keepTail = Math.max(1, maxLength - 1 - keepHead);
	return `${path.slice(0, keepHead)}…${path.slice(path.length - keepTail)}`;
}

/**
 * 缩短一个路径供显示。
 *
 * ~ 与 $PWD 都能用时取更短的那条（cwd 通常比家目录深，所以更常见的是 $PWD）。
 */
export function displayPath(path: string, options: DisplayPathOptions = {}): string {
	if (path === "") return path;
	const candidates: string[] = [];
	if (options.home) {
		const rest = under(path, options.home);
		if (rest !== undefined) candidates.push(`~${rest}`);
	}
	if (options.cwd) {
		const rest = under(path, options.cwd);
		if (rest !== undefined) candidates.push(`$PWD${rest}`);
	}
	const best = candidates.length === 0
		? path
		: candidates.reduce((a, b) => (b.length < a.length ? b : a));
	return ellipsizeMiddle(best, options.maxLength ?? DEFAULT_MAX_LENGTH);
}
