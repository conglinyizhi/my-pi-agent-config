// extensions/photo/index.ts — 照片池：`&img(3)` 引用，/photo:list 看池子，/photo:url 拿上传地址，/photo:open 用系统查看器看
//
// 照片不再推给会话。守护把落盘的图编成短号（1..99），要用哪张就在输入框里写哪张：
//
//   &img(3)              引用编号池里的 3 号
//   &img(/abs/path.jpg)  直接引用一个绝对路径（不走池子，临时图/别处的图都能用）
//
// 展开时把图读成 base64 附到这条消息上，正文里只留一个 `[照片 #3]` 当锚点。
// 跟 `&` 体系的接线在 lib/fragment-providers.ts：这里只注册一个 name="img" 的 provider，
// fragments 扫到 `&img(…)` 就把括号里的原文交给它。
//
// 两条硬约束：
//   1. factory 里不碰网络、不起定时器——注册 provider 是纯内存操作，reload 不该有副作用。
//      真正的 I/O 只发生在 expand 那一刻。
//   2. provider 里没有 ctx（展开发生在 input 事件里，手上只有参数），所以失败原因先攒在
//      lastError 里，由 /photo:list 带出来。

import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerFragmentProvider,
	type FragmentCallResult,
	type FragmentProvider,
} from "../../lib/fragment-providers.ts";
import { getRef, listRefs, manageUrl, uploadUrl, useRef, type RefItem, type RefPool } from "../../lib/photo-refs.ts";

export const IMG_PROVIDER_NAME = "img";

/** /photo:list 一次最多列这么多行：池子满了（99 张）时通知框装不下 */
const MAX_LIST_ROWS = 20;

/**
 * 最近一次 &img 展开没成的原因。
 * provider 手上没有 UI 句柄，提示只能先存这儿；用户看不出「为什么 &img(3) 没展开」时，
 * /photo:list 会把这一行带出来。成功一次就清掉。
 */
let lastError: string | undefined;

/** 测试与命令用：读最近一次展开失败的原因 */
export function lastImgError(): string | undefined {
	return lastError;
}

/** 测试用：清掉攒下的失败原因 */
export function clearImgError(): void {
	lastError = undefined;
}

/** 按扩展名判 mime。认不出的类型直接不展开：mime 塞错模型就看不到图 */
const MIME_BY_EXT: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

export function imageMimeOf(path: string): string | undefined {
	return MIME_BY_EXT[extname(path).toLowerCase()];
}

function note(message: string): void {
	lastError = message;
}

/** 读一张图并包成展开结果；认不出类型或读不到都返回 undefined（原因进 lastError） */
async function imagePartOf(path: string, label: string): Promise<FragmentCallResult | undefined> {
	const mime = imageMimeOf(path);
	if (!mime) {
		note(`认不出 ${basename(path)} 的图片类型（只支持 jpg / jpeg / png / webp）`);
		return undefined;
	}
	let data: Buffer;
	try {
		data = await readFile(path);
	} catch (err) {
		// 路径写进消息是给用户看的（自己引的照片，认得出来）；图片内容不进任何日志
		note(`读不到照片文件 ${path}：${errorText(err)}`);
		return undefined;
	}
	const image: ImageContent = { type: "image", data: data.toString("base64"), mimeType: mime };
	return { text: label, images: [image] };
}

/**
 * `&img(…)` 的 provider。
 *
 * 认三种形态：纯数字（查池子）、以 / 开头的绝对路径（直读）、其余不认（返回 undefined，
 * 交给 fragments 按未知引用处理，原文留在文本里，不会被吞掉）。
 */
export const imgProvider: FragmentProvider = {
	name: IMG_PROVIDER_NAME,
	async expand(args: string): Promise<FragmentCallResult | undefined> {
		// 括号里前后可能带空格、也可能被人顺手加了引号
		const raw = args.trim().replace(/^["']+/, "").replace(/["']+$/, "").trim();
		if (raw === "") {
			note("&img 要带参数：&img(3) 引用编号，或 &img(/绝对/路径.jpg) 直接引用文件");
			return undefined;
		}

		if (/^\d+$/.test(raw)) {
			const n = Number(raw);
			let item: RefItem | undefined;
			try {
				item = await getRef(n);
			} catch (err) {
				note(`查照片编号 #${n} 失败：${errorText(err)}`);
				return undefined;
			}
			if (!item) {
				note(`编号池里没有 #${n}（/photo:list 看现在有哪些）`);
				return undefined;
			}
			const part = await imagePartOf(item.path, `[照片 #${n}]`);
			if (!part) return undefined;
			// 记一笔「这张用过了」给守护做回收参考。不 await：回执发不出去不该影响这次展开
			useRef(n);
			lastError = undefined;
			return part;
		}

		if (raw.startsWith("/")) {
			const part = await imagePartOf(raw, `[照片 ${basename(raw)}]`);
			if (part) lastError = undefined;
			return part;
		}

		note(`&img(…) 只认编号或绝对路径，不认「${raw}」`);
		return undefined;
	},
};

// ── /photo:list 的排版 ──

/** 字节数给人看的写法；守护没给就留一个占位 */
export function formatBytes(bytes?: number): string {
	if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "大小未知";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 时间戳：能解析就按本地时间显示到分钟，解析不了（守护换了格式）原样带出 */
export function formatStamp(iso?: string): string {
	if (!iso) return "";
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function refLine(item: RefItem): string {
	const used = item.lastUsed ? `用过 ${formatStamp(item.lastUsed)}` : item.ts ? `拍于 ${formatStamp(item.ts)}` : "";
	return [`#${item.ref}`, basename(item.path), formatBytes(item.bytes), used].filter((part) => part !== "").join("  ");
}

/** 池子的通知正文。空池、超长、上次展开失败都在这里收成一段话 */
export function poolText(pool: RefPool): string {
	const items = pool.items;
	const lines: string[] = [];
	if (items.length === 0) {
		lines.push("池子还是空的，/photo:url 拿上传地址");
	} else {
		const size = pool.pool !== items.length ? `（守护报池 ${pool.pool}）` : "";
		lines.push(`照片池：${items.length} 张${size}。在输入框里写 &img(编号) 就能引用`);
		lines.push("");
		for (const item of items.slice(0, MAX_LIST_ROWS)) lines.push(refLine(item));
		if (items.length > MAX_LIST_ROWS) {
			lines.push(`……还有 ${items.length - MAX_LIST_ROWS} 张没列（一共 ${items.length} 张）`);
		}
	}
	if (lastError !== undefined) {
		lines.push("");
		lines.push(`上次 &img 没展开成：${lastError}`);
	}
	return lines.join("\n");
}

// ── /photo:open：交给系统默认查看器 ──

/**
 * openWithSystemViewer 用到的子进程最小面（结构上 node:child_process 的 spawn 满足它）。
 * 留这个缝只为测试：单测要验证「xdg-open 不在 PATH」这类分支，又不能真弹一个窗口。
 */
export interface ViewerProcess {
	once(event: "spawn" | "error", listener: (...args: unknown[]) => void): unknown;
	unref(): unknown;
}

export type ViewerSpawn = (bin: string, args: string[], options: { detached: true; stdio: "ignore" }) => ViewerProcess;

/**
 * 用系统默认程序打开一个路径：照片交给默认图片查看器，目录交给文件管理器
 * （具体落到哪个程序由 xdg-open 按文件关联决定，本机装了 Gwenview）。
 *
 * 三条要点：
 *   1. detached + unref：查看器是用户的窗口，不该跟着 pi 的生命周期走。pi 退出或扩展 reload
 *      都不该把它带走，也不该让 pi 挂在那儿等它。
 *   2. 只等 spawn 成功就返回。查看器要用户关窗才会退，退出码还可能非 0（拿它当成败，
 *      就会把「看完关窗」误报成错误）；所以不听 exit / close，只认「进程起没起来」。
 *   3. ENOENT 单独说。没装 xdg-utils 时不能静默失败，得给一句能照做的提示。
 */
export function openWithSystemViewer(path: string, spawnFn: ViewerSpawn = spawn as unknown as ViewerSpawn): Promise<void> {
	return new Promise((resolve, reject) => {
		let child: ViewerProcess;
		try {
			child = spawnFn("xdg-open", [path], { detached: true, stdio: "ignore" });
		} catch (err) {
			// spawn 自己同步抛错（参数非法之类）：按「没起来」算
			reject(new Error(`起不了 xdg-open：${errorText(err)}`));
			return;
		}
		// 监听紧跟着 spawn 挂上：ChildProcess 的 'error' 没有监听时是会直接抛穿进程的
		child.once("error", (raw) => {
			const err = raw as NodeJS.ErrnoException;
			reject(
				err.code === "ENOENT"
					? new Error(`PATH 里没有 xdg-open：装一个 xdg-utils（KDE 桌面一般自带），或用文件管理器手动打开 ${path}`)
					: new Error(`xdg-open 起不来（${path}）：${errorText(err)}`),
			);
		});
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

/** 无参 /photo:open 打开的归档目录：守护按 YYYYMMDD 分子目录往这里放照片 */
export function photoArchiveDir(): string {
	return join(homedir(), ".pi", "agent", "photo-state", "archive");
}

/**
 * 打开照片后带的一句。方向键能翻同目录这件事不是所有人都知道，而它决定了
 * 「看照片」到底是一次只盯一张，还是能把同一批顺完，所以每次都提一句。
 */
const ARROW_KEY_HINT = "打开后可以用方向键翻同目录的其他照片";

/** 参数被识别成哪种目标。失败提示要按种类给：编号指向的路径和用户手打的路由不是一回事 */
type OpenKind = "ref" | "path" | "archive";

export interface PhotoOpenDeps {
	/** 测试注入：默认 openWithSystemViewer（真起 xdg-open） */
	opener?: ((path: string) => Promise<void>) | undefined;
	/** 测试注入：默认 photoArchiveDir() */
	archiveDir?: string | undefined;
}

export interface PhotoOpenOutcome {
	level: "info" | "error";
	message: string;
}

/**
 * `/photo:open` 的主体：认参数 → 确认目标在不在 → 交给注入的 opener。
 *
 * 不抛错、只回一句话：命令处理里能做的就一个 notify，抛出只会让 pi 弹一个更难看的栈。
 * 所以「编号不存在」「文件不在」「xdg-open 不在」都是 error 级的正常结局。
 */
export async function openPhoto(args: string, deps: PhotoOpenDeps = {}): Promise<PhotoOpenOutcome> {
	const opener = deps.opener ?? openWithSystemViewer;
	// 前后可能带空格、也可能被人顺手加了引号（跟 &img 的解析对齐）
	const raw = args.trim().replace(/^["']+/, "").replace(/["']+$/, "").trim();

	let target: string;
	let kind: OpenKind;
	let subject: string;
	if (raw === "") {
		// 无参看整个归档：交给文件管理器开（不想用 pi 时也能直接翻磁盘上那堆目录）
		target = deps.archiveDir ?? photoArchiveDir();
		kind = "archive";
		subject = "归档目录";
	} else if (/^\d+$/.test(raw)) {
		const n = Number(raw);
		let item: RefItem | undefined;
		try {
			item = await getRef(n);
		} catch (err) {
			return { level: "error", message: `查照片编号 #${n} 失败：${errorText(err)}` };
		}
		if (!item) return { level: "error", message: `编号池里没有 #${n}（/photo:list 看现在有哪些）` };
		target = item.path;
		kind = "ref";
		subject = `照片 #${n}`;
	} else if (raw.startsWith("/")) {
		target = raw;
		kind = "path";
		subject = basename(raw);
	} else {
		return { level: "error", message: `/photo:open 只认编号或绝对路径，不认「${raw}」` };
	}

	const missing = await missingText(target, kind);
	if (missing !== undefined) return { level: "error", message: missing };

	try {
		await opener(target);
	} catch (err) {
		return { level: "error", message: `没能打开 ${target}：${errorText(err)}` };
	}
	const tail = kind === "archive" ? `目录里按日期分文件夹，点进任意一天打开一张，${ARROW_KEY_HINT}` : ARROW_KEY_HINT;
	return { level: "info", message: `已交给系统默认查看器打开 ${subject}：${target}\n${tail}` };
}

/** 目标不在时报哪句话；在就返回 undefined */
async function missingText(path: string, kind: OpenKind): Promise<string | undefined> {
	try {
		await stat(path);
		return undefined;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") return `看不了 ${path}：${errorText(err)}`;
		if (kind === "archive") return `归档目录还不存在（${path}）：/photo:url 拿上传地址，先传一张照片上来，守护会建目录`;
		if (kind === "ref") return `这个编号指的文件不在了（${path}）：池子里还记着它，磁盘上已经没有`;
		return `文件不在（${path}）`;
	}
}

/**
 * /photo:list 末尾的管理页入口。拿不到口令就返回 undefined：管理页只是列表的附加入口，
 * 缺了它不该把「池子里有什么」这件正事一起带崩。
 */
export async function manageHintText(): Promise<string | undefined> {
	let url: string;
	try {
		url = await manageUrl();
	} catch {
		return undefined;
	}
	// 口令就在地址里，而这里的目的就是把它交给用户去浏览器里打开：它该出现在命令输出里，
	// 但不该被写进日志（调用方只管 notify，不过手打印）
	return `管理页：${url}\n本机浏览器打开可以看缩略图与管理`;
}

// ── 终端二维码 ──

/**
 * 用本机 qrencode 画一个终端二维码。
 * 画不出来返回 undefined：二维码只是「省得手打 URL」的便利，没有它上传地址照样能用。
 * token 在 URL 里，只在 argv 里过一趟，不写任何日志。
 */
export function qrCodeText(text: string, timeoutMs = 2000): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"qrencode",
			["-t", "ANSIUTF8", "-o", "-", text],
			{ timeout: timeoutMs, maxBuffer: 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					resolve(undefined);
					return;
				}
				const qr = stdout.replace(/\s+$/, "");
				resolve(qr === "" ? undefined : qr);
			},
		);
	});
}

export interface PhotoExtensionDeps {
	/** 测试注入：默认 qrCodeText（会起 qrencode 子进程） */
	qrCode?: (text: string) => Promise<string | undefined>;
	/** 测试注入：默认 openWithSystemViewer（会起 xdg-open，弹一个真窗口） */
	opener?: ((path: string) => Promise<void>) | undefined;
	/** 测试注入：默认 photoArchiveDir() */
	archiveDir?: string | undefined;
}

export default function photoExtension(pi: ExtensionAPI, deps: PhotoExtensionDeps = {}): void {
	const qrCode = deps.qrCode ?? qrCodeText;
	const openDeps: PhotoOpenDeps = { opener: deps.opener, archiveDir: deps.archiveDir };

	// 注册（同名覆盖，reload 是正常路径）。纯内存动作，没有 I/O、没有定时器。
	registerFragmentProvider(imgProvider);

	pi.registerCommand("photo:list", {
		description: "列出照片编号池（输入框里 &img(编号) 引用）；末尾附本机管理页地址",
		handler: async (_args, ctx) => {
			let pool: RefPool;
			try {
				pool = await listRefs();
			} catch (err) {
				ctx.ui.notify(`拿不到照片池：${errorText(err)}`, "error");
				return;
			}
			const blocks = [poolText(pool)];
			const manage = await manageHintText();
			if (manage !== undefined) blocks.push(manage);
			ctx.ui.notify(blocks.join("\n\n"), "info");
		},
	});

	pi.registerCommand("photo:open", {
		description: "用系统默认查看器打开照片：/photo:open 3、/photo:open /绝对/路径.jpg；无参开归档目录",
		handler: async (args, ctx) => {
			const outcome = await openPhoto(args, openDeps);
			ctx.ui.notify(outcome.message, outcome.level);
		},
	});

	pi.registerCommand("photo:url", {
		description: "显示手机上传地址（附终端二维码）；拍完的照片进池子，用 &img(编号) 取",
		handler: async (_args, ctx) => {
			let url: string;
			try {
				url = await uploadUrl();
			} catch (err) {
				ctx.ui.notify(`拿不到上传地址：${errorText(err)}`, "error");
				return;
			}
			const head = `手机上传地址（手机与电脑在同一局域网，浏览器打开）：\n${url}`;
			const qr = await qrCode(url);
			ctx.ui.notify(qr ? `${head}\n\n${qr}` : head, "info");
		},
	});
}

function errorText(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const cause = (err as { cause?: unknown }).cause;
	const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
	return code ? `${err.message}（${code}）` : err.message;
}
