// lib/photo-refs.ts — photo 守护的 HTTP 客户端（照片编号池）
//
// 照片不再自动推给会话：守护把落盘的图编成短号（1..99），pi 侧只在真正用到时才去取——
// 用户在输入框里打 `&img(3)`，展开的那一刻才问守护「3 号是哪张」。
//
// 这个文件只管「怎么跟守护说话」：地址、口令、超时、可读的错误文案，以及几个入口 URL。不 import 任何 pi API，
// 所以单测可以直接对着一个假守护跑（见 extensions/photo/photo-refs.test.ts）。
//
// 两条约束：
//   1. 口令（token）只在请求 query 里出现，绝不进错误消息、绝不进日志——
//      日志会落盘，也会被 journalctl 一把捞出来。
//      唯一的例外是 manageUrl()：它存在的意义就是把带口令的地址交给用户去浏览器里打开，
//      所以调用方（/photo:list）必须把它当「给用户看的地址」用，不能拿去写日志。
//   2. 连接与整体都封顶（默认 5s）。守护是本机进程，超时就是没在跑，
//      与其让展开挂在那里，不如快点失败、把原因交给上层显示。

import { readFile } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";

/** 守护的 HTTP 面默认监听 127.0.0.1:8787；换端口/换机器用 PI_PHOTO_BASE 覆盖 */
export const DEFAULT_PHOTO_BASE = "http://127.0.0.1:8787";
/** 单次请求的上限。够本机一个来回，又不至于把输入框卡住 */
export const DEFAULT_TIMEOUT_MS = 5000;

/** 池子里的一项。path 是绝对路径，pi 直接读，不去猜守护的目录布局 */
export interface RefItem {
	ref: number;
	path: string;
	bytes?: number;
	ts?: string;
	lastUsed?: string;
}

export interface RefPool {
	/** 守护报的池大小。与 items.length 的关系由守护定义，展示时两者都留着 */
	pool: number;
	items: RefItem[];
}

export interface PhotoRefsOptions extends PhotoTokenOptions {
	/** 覆盖守护地址（默认 PI_PHOTO_BASE，再默认 127.0.0.1:8787） */
	base?: string;
	timeoutMs?: number;
	/** useRef 这类「不该影响主流程」的失败往哪写。默认丢进无声处：这个层里没有 ctx，
	 *  而往 stdout 打日志在本仓库算调试残留（pre-commit 检查会拦）。调用方接管：
	 *  扩展把它记进 lastError，需要时由 /photo:list 带出来 */
	logger?: (message: string) => void;
}

export interface PhotoRefsClient {
	listRefs(): Promise<RefPool>;
	/** 编号不在池子里（404）返回 undefined，别的毛病照常抛 */
	getRef(n: number): Promise<RefItem | undefined>;
	/** 记一笔「这张用过了」。不抛错、不返回 Promise：调用方不该为它停下来 */
	useRef(n: number): void;
	/** 手机上传地址，一定带 ?k=<token> */
	uploadUrl(): Promise<string>;
	/** 本机管理页地址（缩略图与删除都在那儿），一定带 ?k=<token> */
	manageUrl(): Promise<string>;
}

/** 口令对不上。单独一个类型，好在 uploadUrl 的回退逻辑里把它跟「拿不到」区分开 */
class PhotoAuthError extends Error {}

export function photoBase(): string {
	const explicit = explicitPhotoBase();
	return (explicit !== "" ? explicit : DEFAULT_PHOTO_BASE).replace(/\/+$/, "");
}

/** 用户显式给过 BASE 吗？没给的话 uploadUrl 才会去猜局域网地址 */
function explicitPhotoBase(): string {
	return process.env.PI_PHOTO_BASE?.trim() ?? "";
}

/** 手机要打开的地址不能是 127.0.0.1：守护在 journal 里打了局域网地址，HTTP 面却没给 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "0.0.0.0", "::1", "localhost"]);

/**
 * 把回环/未指定地址换成本机一个真实存在的局域网 IPv4（挑法与 photo/netinfo.go 一致：
 * 私有网段优先，其次第一个非回环 IPv4，一个都找不到就原样返回）。
 * 换错网卡（docker0、tun0 这些）时用 PI_PHOTO_BASE 直接指定，那个值不会被改。
 */
export function reachableBase(base: string, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string {
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		return base;
	}
	if (!LOOPBACK_HOSTS.has(url.hostname)) return base;
	const host = pickLanHost(interfaces);
	if (host === undefined) return base;
	url.hostname = host;
	return url.toString().replace(/\/+$/, "");
}

/** 挑一个能在局域网里被手机访问到的 IPv4；没有就返回 undefined */
export function pickLanHost(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | undefined {
	let fallback: string | undefined;
	for (const list of Object.values(interfaces)) {
		for (const info of list ?? []) {
			if (info.internal) continue; // 回环
			if (info.family !== "IPv4") continue;
			if (info.address.startsWith("169.254.")) continue; // 链路本地，手机也到不了
			if (isPrivateV4(info.address)) return info.address;
			fallback ??= info.address;
		}
	}
	return fallback;
}

function isPrivateV4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
	const [a, b] = parts as [number, number, number, number];
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function photoTokenPath(): string {
	const raw = process.env.PI_PHOTO_TOKEN_FILE?.trim();
	return raw && raw !== "" ? raw : join(homedir(), ".pi", "agent", "photo-state", "token");
}

export interface PhotoTokenOptions {
	/** 直接给口令；给了就不再读文件 */
	token?: string;
	/** 口令文件路径（默认 PI_PHOTO_TOKEN_FILE，再默认 ~/.pi/agent/photo-state/token） */
	tokenFile?: string;
}

/**
 * 读 photo 口令（每次现取，不缓存：守护重启可能换文件内容）。
 *
 * 抽成导出是因为「跟守护说话」和「拼本机管理页地址」都要它：两处各读一遍，
 * 迟早会在「文件不存在 / 文件为空」这些分支上分叉，提示语也会长得不一样。
 */
export async function readPhotoToken(opts: PhotoTokenOptions = {}): Promise<string> {
	if (opts.token !== undefined) {
		if (opts.token.trim() === "") throw new Error("photo 口令是空的：给进来的 token 是空串，检查调用方怎么传的");
		return opts.token.trim();
	}
	const tokenFile = opts.tokenFile?.trim() || photoTokenPath();
	let text: string;
	try {
		text = await readFile(tokenFile, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(`photo 守护还没初始化：口令文件不存在（${tokenFile}）。先把 photo 守护跑起来，它会生成口令`);
		}
		throw new Error(`photo 守护还没初始化：读不了口令文件 ${tokenFile}：${errorText(err)}`);
	}
	const value = text.trim();
	if (value === "") {
		throw new Error(`photo 守护还没初始化：口令文件是空的（${tokenFile}）。删掉它再重启守护会重新生成`);
	}
	return value;
}

export function createPhotoRefs(opts: PhotoRefsOptions = {}): PhotoRefsClient {
	const explicit = opts.base?.trim() || explicitPhotoBase();
	const base = (opts.base?.trim() || photoBase()).replace(/\/+$/, "");
	// 只有用默认地址时才动它：用户显式给的地址一律照原样用
	const phoneBase = explicit !== "" ? base : reachableBase(base);
	const tokenFile = opts.tokenFile?.trim() || photoTokenPath();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const log = opts.logger ?? (() => {});

	// 口令每次现取（readPhotoToken 内部不缓存）：守护重启可能换文件内容，缓存住只会拿到旧口令
	const token = (): Promise<string> => readPhotoToken(opts.token !== undefined ? { token: opts.token, tokenFile } : { tokenFile });

	const call = async (
		apiPath: string,
		key: string,
		init: { method?: string } = {},
	): Promise<{ status: number; text: string }> => {
		const url = `${base}${apiPath}${apiPath.includes("?") ? "&" : "?"}k=${encodeURIComponent(key)}`;
		let res: Response;
		try {
			res = await fetch(url, {
				method: init.method ?? "GET",
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			const name = err instanceof Error ? err.name : "";
			if (name === "TimeoutError" || name === "AbortError") {
				throw new Error(`photo 守护没响应（${apiPath}，${timeoutMs}ms 超时）：${base} 上跑着守护吗`);
			}
			throw new Error(`连不上 photo 守护（${base}）：${errorText(err)}`);
		}
		return { status: res.status, text: await res.text() };
	};

	/** 非 2xx 的统一出口：401/403 单独说，别让人以为是网络问题 */
	const failStatus = (status: number, where: string): never => {
		if (status === 401 || status === 403) {
			throw new PhotoAuthError(`photo 守护不认这个口令（${where}）：token 文件与守护不同步了吧，重启守护或对齐 photo-state/token`);
		}
		throw new Error(`photo 守护的 ${where} 回了 HTTP ${status}`);
	};

	const ok = (status: number): boolean => status >= 200 && status < 300;

	return {
		async listRefs(): Promise<RefPool> {
			const key = await token();
			const where = "/refs";
			const { status, text } = await call(where, key);
			if (status === 404) {
				throw new Error(`photo 守护没有编号池接口（${where} 404）：守护版本太旧，换新版再试`);
			}
			if (!ok(status)) failStatus(status, where);
			const body = parseJson(text, where) as { pool?: unknown; items?: unknown } | undefined;
			const items = normalizeItems(body?.items);
			const pool = typeof body?.pool === "number" && Number.isFinite(body.pool) ? body.pool : items.length;
			return { pool, items };
		},

		async getRef(n: number): Promise<RefItem | undefined> {
			const key = await token();
			const where = `/refs/${n}`;
			const { status, text } = await call(where, key);
			// 404 是正常结局：这个号被回收了 / 本来就没占过，让调用方当「没有」处理
			if (status === 404) return undefined;
			if (!ok(status)) failStatus(status, where);
			const item = normalizeItem(parseJson(text, where));
			if (!item) throw new Error(`photo 守护的 ${where} 回的形状不认识（要 {ref, path}）`);
			return item;
		},

		useRef(n: number): void {
			// 回执只是「这张用过了」的软标记：失败不该影响这次展开，所以不等、不抛，
			// 由内部自己记一行日志（口令也在错误消息之外）
			void (async () => {
				const key = await token();
				const where = `/refs/${n}/use`;
				const { status } = await call(where, key, { method: "POST" });
				if (!ok(status)) throw new Error(`HTTP ${status}`);
			})().catch((err: unknown) => {
				log(`编号 #${n} 的使用回执没发出去：${errorText(err)}（不影响本次引用）`);
			});
		},

		async manageUrl(): Promise<string> {
			const key = await token();
			// 这是给本机浏览器看的：用 base（默认 127.0.0.1），不换成局域网地址——
			// 管理页的口令就在地址里，不该跟着手机那边的地址一起往局域网里跑
			return `${base}/manage?k=${encodeURIComponent(key)}`;
		},

		async uploadUrl(): Promise<string> {
			const key = await token();
			let fromStatus = "";
			try {
				const { status, text } = await call("/status", key);
				if (status === 401 || status === 403) {
					throw new PhotoAuthError(`photo 守护不认这个口令（/status）：token 文件与守护不同步了吧`);
				}
				if (ok(status)) {
					const body = parseJson(text, "/status") as { url?: unknown } | undefined;
					const raw = body && typeof body.url === "string" ? body.url.trim() : "";
					if (raw !== "") fromStatus = raw;
				}
			} catch (err) {
				// 口令不对是要人管的，不能糊过去；其它情况（守护旧版本没有 url 字段、网络抖一下）
				// 都退回 BASE 拼 URL：上传页本来就在根路径上
				if (err instanceof PhotoAuthError) throw err;
			}
			return fromStatus !== "" ? withToken(fromStatus, key) : `${phoneBase}/?k=${encodeURIComponent(key)}`;
		},
	};
}

/** 默认客户端。地址与口令在每次调用时现取，所以测试里改环境变量就能改指向 */
export function defaultPhotoRefs(): PhotoRefsClient {
	return createPhotoRefs();
}

export function listRefs(): Promise<RefPool> {
	return defaultPhotoRefs().listRefs();
}

export function getRef(n: number): Promise<RefItem | undefined> {
	return defaultPhotoRefs().getRef(n);
}

export function useRef(n: number): void {
	defaultPhotoRefs().useRef(n);
}

export function uploadUrl(): Promise<string> {
	return defaultPhotoRefs().uploadUrl();
}

/** 本机管理页地址（带口令）。/photo:list 用它把入口带出来 */
export function manageUrl(): Promise<string> {
	return defaultPhotoRefs().manageUrl();
}

/** 给 URL 补上 ?k=；已经有了就原样返回（守护可能自己带了口令） */
function withToken(url: string, token: string): string {
	if (/[?&]k=/.test(url)) return url;
	return `${url}${url.includes("?") ? "&" : "?"}k=${encodeURIComponent(token)}`;
}

function parseJson(text: string, where: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`photo 守护的 ${where} 没回合法 JSON`);
	}
}

/** 守护的 items 不保证每项都能用：没有编号或路径的项直接丢，别拿它去读文件 */
function normalizeItems(raw: unknown): RefItem[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry) => {
		const item = normalizeItem(entry);
		return item ? [item] : [];
	});
}

function normalizeItem(raw: unknown): RefItem | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const ref = typeof record.ref === "number" ? record.ref : Number(record.ref);
	const path = record.path;
	if (!Number.isInteger(ref) || typeof path !== "string" || path === "") return undefined;
	return {
		ref,
		path,
		...(typeof record.bytes === "number" ? { bytes: record.bytes } : {}),
		...(typeof record.ts === "string" ? { ts: record.ts } : {}),
		...(typeof record.lastUsed === "string" ? { lastUsed: record.lastUsed } : {}),
	};
}

/** fetch 的错误常常只有一句 "fetch failed"，真正的码在 cause 里 */
function errorText(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const cause = (err as { cause?: unknown }).cause;
	const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
	return code ? `${err.message}（${code}）` : err.message;
}
