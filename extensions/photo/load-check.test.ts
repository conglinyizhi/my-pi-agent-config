// extensions/photo/load-check.mjs — 冒烟：照 pi 的方式用 jiti 载入这个扩展
//
// 跑法（在 ~/.pi/agent 下）：node extensions/photo/load-check.mjs
//
// 不启动真 pi 会话，只做三件事：
//   1. 用 jiti（pi 加载扩展用的那套）import 本目录的 index.ts，拿到 factory
//   2. 用假的 pi API 跑一遍 factory，确认注册出 name=img 的 provider 与两条命令
//   3. 确认没挂 session_start / session_shutdown 这类常驻资源（长连接已经没有了）
// 这个文件不是扩展入口（pi 只加载目录里的 index.ts），只是给人手动跑的自检。

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentDir = join(here, "..", "..");

/**
 * 找 pi 自带的 jiti。它是 pi 的依赖、不是本工程的顶层依赖，pnpm 布局下不在 node_modules 根上，
 * 所以按几处常见位置找一找；一处都没有就退回 node 自带的 TS 加载（v26 默认就能直接 import .ts）。
 */
function findJiti() {
	const candidates = [join(agentDir, "node_modules", "jiti", "lib", "jiti-static.mjs")];
	const pnpmDir = join(agentDir, "node_modules", ".pnpm");
	try {
		for (const entry of readdirSync(pnpmDir)) {
			if (entry.startsWith("jiti@")) candidates.push(join(pnpmDir, entry, "node_modules", "jiti", "lib", "jiti-static.mjs"));
		}
	} catch {
		// 没有 .pnpm 目录就算了，按下面的退回路径走
	}
	return candidates.find((path) => existsSync(path));
}

const jitiPath = findJiti();
let load;
let via = "node 自带的 TS 加载";
if (jitiPath) {
	const { createJiti } = await import(pathToFileURL(jitiPath).href);
	const jiti = createJiti(import.meta.url, { interopDefault: true, tryNative: false });
	load = (path) => jiti.import(path, { default: true });
	via = "jiti（pi 加载扩展用的那套）";
} else {
	load = async (path) => (await import(pathToFileURL(path).href)).default;
}

const factory = await load(join(here, "index.ts"));
if (typeof factory !== "function") throw new Error("扩展入口的默认导出不是 factory 函数");

const onTypes = [];
const commands = [];
factory({
	on(type) {
		onTypes.push(type);
	},
	registerCommand(name, command) {
		commands.push({ name, hasHandler: typeof command?.handler === "function" });
	},
});

const providers = jitiPath
	? await load(join(agentDir, "lib", "fragment-providers.ts"))
	: await import(pathToFileURL(join(agentDir, "lib", "fragment-providers.ts")).href);
const img = providers.lookupFragmentProvider("img");
if (!img) throw new Error("没有注册出 name=img 的 provider");
if (typeof img.expand !== "function") throw new Error("img provider 没有 expand");
for (const name of ["photo:list", "photo:url"]) {
	if (!commands.some((command) => command.name === name && command.hasHandler)) {
		throw new Error(`缺命令 /${name}`);
	}
}
for (const type of ["session_start", "session_shutdown"]) {
	if (onTypes.includes(type)) throw new Error(`不该再挂 ${type}（已经没有长连接了）`);
}

// 不存在的编号 / 认不了的参数都该是「不展开」，而不是抛错
for (const args of ["99", "nonsense"]) {
	const result = await img.expand(args);
	if (result !== undefined) throw new Error(`&img(${args}) 应当不展开，实际回了 ${JSON.stringify(result)}`);
}

console.log(`✓ 扩展能加载（${via}）：factory 是函数，注册了 img provider（expand 在）`);
console.log(`✓ 命令：${commands.map((command) => `/${command.name}`).join("、")}`);
console.log(`✓ pi.on 挂的事件：${onTypes.length === 0 ? "（无，没有常驻资源）" : onTypes.join("、")}`);
console.log("✓ 认不了的 &img(...) 返回 undefined，不抛错");
