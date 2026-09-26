// extensions/photo/index.test.ts — &img 展开与 /photo:list|url 的接线
//
// 跑法：node --experimental-strip-types extensions/photo/index.test.ts
//
// 用假的 pi / ctx 跑真 factory，守护那边起一个真的假 HTTP 守护（临时端口）：
// provider 通过 lib/photo-refs 的默认入口说话，所以这里用 PI_PHOTO_BASE / PI_PHOTO_TOKEN_FILE
// 把默认入口指到假守护上——测的就是扩展里那条真实路径，不用另外注入客户端。

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearFragmentProviders, lookupFragmentProvider, type FragmentProvider } from "../../lib/fragment-providers.ts";
import photoExtension, { clearImgError, formatBytes, formatStamp, imageMimeOf, lastImgError } from "./index.ts";
import { startFakeDaemon, waitFor, type FakeDaemon } from "./fake-daemon.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
/** 20 行是这个上限（见 index.ts 的 MAX_LIST_ROWS） */
const MAX_LIST_ROWS = 20;

type Command = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> };

interface FakePi {
	commands: Map<string, Command>;
	api: ExtensionAPI;
}

function fakePi(): FakePi {
	const commands = new Map<string, Command>();
	const api = {
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
	};
	return { commands, api: api as unknown as ExtensionAPI };
}

function fakeCtx() {
	const notices: Array<{ message: string; level: string }> = [];
	return {
		notices,
		last: () => notices.at(-1),
		ctx: {
			hasUI: true,
			mode: "tui",
			ui: {
				notify(message: string, level = "info") {
					notices.push({ message, level });
				},
			},
		},
	};
}

let dir = "";
let tokenFile = "";
let daemon: FakeDaemon | undefined;
let pi: FakePi | undefined;
const qrCalls: string[] = [];
const touchedEnv = new Set<string>();

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-photo-"));
	tokenFile = join(dir, "token");
	writeFileSync(tokenFile, `${TOKEN}\n`);
	clearImgError();
	clearFragmentProviders();
	qrCalls.length = 0;
});

afterEach(async () => {
	if (daemon) {
		await daemon.close();
		daemon = undefined;
	}
	for (const key of touchedEnv) delete process.env[key];
	touchedEnv.clear();
	clearFragmentProviders();
	clearImgError();
	rmSync(dir, { recursive: true, force: true });
});

function setEnv(key: string, value: string): void {
	touchedEnv.add(key);
	process.env[key] = value;
}

interface BootOptions {
	/** 假守护的配置（池子、返回码……） */
	daemon?: Parameters<typeof startFakeDaemon>[0];
	/** 二维码实现；默认回一个假二维码，传 undefined 就是「画不出来」 */
	qrCode?: (text: string) => Promise<string | undefined>;
}

/** 起假守护 + 装扩展，并把扩展指向它 */
async function boot(opts: BootOptions = {}) {
	daemon = await startFakeDaemon(opts.daemon ?? {});
	setEnv("PI_PHOTO_BASE", daemon.base);
	setEnv("PI_PHOTO_TOKEN_FILE", tokenFile);
	pi = fakePi();
	const qrCode = opts.qrCode ?? (async (text: string) => (qrCalls.push(text), "█▀█\n▀▀▀"));
	photoExtension(pi.api, { qrCode });
	const provider = lookupFragmentProvider("img");
	assert.ok(provider, "factory 跑完应该注册出 img provider");
	return { d: daemon, provider, commands: pi.commands };
}

/** 装扩展，但把它指到一个已经关掉的守护上（端口还在，只是没人听） */
async function bootAgainstDeadDaemon() {
	daemon = await startFakeDaemon();
	const base = daemon.base;
	await daemon.close();
	daemon = undefined;
	setEnv("PI_PHOTO_BASE", base);
	setEnv("PI_PHOTO_TOKEN_FILE", tokenFile);
	pi = fakePi();
	photoExtension(pi.api, { qrCode: async () => undefined });
	return { base, provider: lookupFragmentProvider("img") as FragmentProvider, commands: pi.commands };
}

/** 造一张真图，返回它的绝对路径 */
function makeImage(name: string, body = "fake-jpeg-bytes"): string {
	const path = join(dir, name);
	writeFileSync(path, body);
	return path;
}

describe("img provider 注册", () => {
	it("factory 注册 name=img 的 provider；重复加载覆盖旧的、不报错", async () => {
		const { provider } = await boot();
		assert.equal(provider.name, "img");

		// reload 会重跑 factory：同名再注册一次必须是正常路径
		const again = fakePi();
		photoExtension(again.api, { qrCode: async () => undefined });
		const after = lookupFragmentProvider("img");
		assert.ok(after);
		assert.equal(after.name, "img");
	});

	it("注册是纯内存动作：factory 不碰网络（守护不在也照样装得上）", async () => {
		// 把地址指到一个必然没人听的端口：factory 里只要有 I/O 就会露出来
		setEnv("PI_PHOTO_BASE", "http://127.0.0.1:9");
		setEnv("PI_PHOTO_TOKEN_FILE", join(dir, "没有这个文件"));
		const local = fakePi();
		photoExtension(local.api, { qrCode: async () => undefined });
		assert.ok(lookupFragmentProvider("img"));
	});
});

describe("&img(编号)", () => {
	it("命中：正文留锚点，图片按 base64 附上，并记一笔 use", async () => {
		const image = makeImage("3.jpg", "three-bytes");
		const { d, provider } = await boot({ daemon: { refs: [{ ref: 3, path: image, bytes: 11 }] } });

		const result = await provider.expand("3");
		assert.deepEqual(result, {
			text: "[照片 #3]",
			images: [{ type: "image", data: readFileSync(image).toString("base64"), mimeType: "image/jpeg" }],
		});
		assert.equal(lastImgError(), undefined);

		// use 回执是「不 await」的，等它落地再看
		await waitFor(() => d.requestsOn("POST", "/refs/3/use").length === 1);
	});

	it("前后带空格或引号也认", async () => {
		const image = makeImage("7.png");
		const { d, provider } = await boot({ daemon: { refs: [{ ref: 7, path: image }] } });
		const result = await provider.expand(' "7" ');
		assert.equal(result?.text, "[照片 #7]");
		assert.equal(result?.images?.[0].mimeType, "image/png");
		// 等回执落地再收尾：不然它会在用例之间飘着，日志看着像出错
		await waitFor(() => d.requestsOn("POST", "/refs/7/use").length === 1);
	});

	it("编号不在池里：返回 undefined（交给 fragments 当未知处理），原因存进 lastError", async () => {
		const { provider } = await boot({ daemon: { refs: [{ ref: 1, path: makeImage("1.jpg") }] } });
		const result = await provider.expand("9");
		assert.equal(result, undefined);
		assert.match(lastImgError() ?? "", /没有 #9/);
	});

	it("守护没跑：返回 undefined，不往外抛", async () => {
		const { provider } = await bootAgainstDeadDaemon();

		const result = await provider.expand("3");
		assert.equal(result, undefined);
		assert.match(lastImgError() ?? "", /连不上 photo 守护/);
	});

	it("编号指向的文件已经不在：返回 undefined 并说明读不到", async () => {
		const { provider } = await boot({ daemon: { refs: [{ ref: 4, path: join(dir, "已经删了.jpg") }] } });
		const result = await provider.expand("4");
		assert.equal(result, undefined);
		assert.match(lastImgError() ?? "", /读不到照片文件/);
	});
});

describe("&img(绝对路径)", () => {
	it("直读文件，正文用文件名当锚点", async () => {
		const image = makeImage("shot.png", "png-bytes");
		const { provider } = await boot();
		const result = await provider.expand(image);
		assert.deepEqual(result, {
			text: "[照片 shot.png]",
			images: [{ type: "image", data: readFileSync(image).toString("base64"), mimeType: "image/png" }],
		});
	});

	it("文件不存在：返回 undefined", async () => {
		const { provider } = await boot();
		assert.equal(await provider.expand(join(dir, "没有这张.webp")), undefined);
		assert.match(lastImgError() ?? "", /读不到照片文件/);
	});

	it("不支持的扩展名：不展开（mime 塞错模型就看不到图）", async () => {
		const gif = makeImage("anim.gif", "GIF89a");
		const { provider } = await boot();
		assert.equal(await provider.expand(gif), undefined);
		assert.match(lastImgError() ?? "", /认不出/);
	});
});

describe("&img 的非法参数", () => {
	it("不是编号也不是绝对路径：返回 undefined", async () => {
		const { provider } = await boot();
		for (const args of ["abc", "../relative.jpg", "http://x/y.jpg", "3x"]) {
			clearImgError();
			assert.equal(await provider.expand(args), undefined, `args=${args}`);
			assert.ok(lastImgError(), `args=${args} 应记下原因`);
		}
	});

	it("空参数（写了 &img 没写括号）：返回 undefined", async () => {
		const { provider } = await boot();
		assert.equal(await provider.expand(""), undefined);
		assert.match(lastImgError() ?? "", /要带参数/);
	});
});

describe("/photo:list", () => {
	async function list(opts: BootOptions = {}) {
		const booted = await boot(opts);
		const env = fakeCtx();
		await booted.commands.get("photo:list")?.handler("", env.ctx);
		return { ...booted, env };
	}

	it("空池：给出 /photo:url 的指引", async () => {
		const { env } = await list();
		assert.equal(env.last()?.level, "info");
		assert.equal(env.last()?.message, "池子还是空的，/photo:url 拿上传地址");
	});

	it("列出编号、文件名、大小、最后使用时间", async () => {
		const image = makeImage("1790398718082-0003.jpg");
		const { env } = await list({
			daemon: { refs: [{ ref: 3, path: image, bytes: 4096, ts: "2026-09-26T05:00:00Z", lastUsed: "2026-09-26T05:10:00Z" }] },
		});
		const message = env.last()?.message ?? "";
		assert.match(message, /照片池：1 张/);
		assert.match(message, /&img\(编号\)/);
		assert.match(message, /#3/);
		assert.match(message, /1790398718082-0003\.jpg/);
		assert.match(message, /4\.0 KB/);
		assert.match(message, /用过 09-26 13:10/); // 时间戳按本地时间渲染
	});

	it("超过 20 行就截断并提醒还有多少张", async () => {
		const refs = Array.from({ length: MAX_LIST_ROWS + 5 }, (_, i) => ({
			ref: i + 1,
			path: makeImage(`${i + 1}.jpg`),
		}));
		const { env } = await list({ daemon: { refs } });
		const message = env.last()?.message ?? "";
		assert.match(message, new RegExp(`照片池：${MAX_LIST_ROWS + 5} 张`));
		assert.match(message, new RegExp(`#${MAX_LIST_ROWS}\\b`));
		assert.doesNotMatch(message, new RegExp(`#${MAX_LIST_ROWS + 1}\\b`));
		assert.match(message, /还有 5 张没列/);
	});

	it("带上上次 &img 没展开成的原因", async () => {
		const booted = await boot();
		await booted.provider.expand("42");
		const env = fakeCtx();
		await booted.commands.get("photo:list")?.handler("", env.ctx);
		assert.match(env.last()?.message ?? "", /没有 #42/);
	});

	it("拿不到池子（守护没跑）：报一行错，不抛", async () => {
		const { commands } = await bootAgainstDeadDaemon();
		const env = fakeCtx();
		await commands.get("photo:list")?.handler("", env.ctx);
		assert.equal(env.last()?.level, "error");
		assert.match(env.last()?.message ?? "", /拿不到照片池/);
	});
});

describe("/photo:url", () => {
	async function url(opts: BootOptions = {}) {
		const booted = await boot(opts);
		const env = fakeCtx();
		await booted.commands.get("photo:url")?.handler("", env.ctx);
		return { ...booted, env };
	}

	it("给出带口令的上传地址与二维码", async () => {
		const { d, env } = await url();
		const message = env.last()?.message ?? "";
		assert.match(message, new RegExp(`${d.base.replace(/[/.]/g, "\\$&")}/\\?k=${TOKEN}`));
		assert.match(message, /█▀█/);
		assert.deepEqual(qrCalls, [`${d.base}/?k=${TOKEN}`]);
	});

	it("画不出二维码就只给地址（二维码只是便利）", async () => {
		const { env } = await url({ qrCode: async () => undefined });
		const message = env.last()?.message ?? "";
		assert.match(message, /手机上传地址/);
		assert.match(message, /\?k=/);
		assert.doesNotMatch(message, /█▀█/);
	});

	it("守护还没初始化（没有口令文件）：报一行错", async () => {
		daemon = await startFakeDaemon();
		setEnv("PI_PHOTO_BASE", daemon.base);
		pi = fakePi();
		// 直接把 token 文件指到不存在的地方：扩展那条真实路径就会报「守护还没初始化」
		setEnv("PI_PHOTO_TOKEN_FILE", join(dir, "没有这个文件"));
		photoExtension(pi.api, { qrCode: async () => undefined });
		const env = fakeCtx();
		await pi.commands.get("photo:url")?.handler("", env.ctx);
		assert.equal(env.last()?.level, "error");
		assert.match(env.last()?.message ?? "", /守护还没初始化/);
	});
});

describe("排版小工具", () => {
	it("formatBytes：给人看的单位，缺值有占位", () => {
		assert.equal(formatBytes(512), "512 B");
		assert.equal(formatBytes(4096), "4.0 KB");
		assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");
		assert.equal(formatBytes(undefined), "大小未知");
	});

	it("formatStamp：ISO 转本地时间，坏值原样带出", () => {
		const at = new Date("2026-09-26T05:10:00Z");
		const pad = (n: number) => String(n).padStart(2, "0");
		const local = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
		assert.equal(formatStamp("2026-09-26T05:10:00Z"), local);
		assert.equal(formatStamp("说不清"), "说不清");
		assert.equal(formatStamp(undefined), "");
	});

	it("imageMimeOf：只认 jpg/jpeg/png/webp", () => {
		assert.equal(imageMimeOf("/a/1.JPG"), "image/jpeg");
		assert.equal(imageMimeOf("/a/1.jpeg"), "image/jpeg");
		assert.equal(imageMimeOf("/a/1.png"), "image/png");
		assert.equal(imageMimeOf("/a/1.webp"), "image/webp");
		assert.equal(imageMimeOf("/a/1.gif"), undefined);
	});
});
