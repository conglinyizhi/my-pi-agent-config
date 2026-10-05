// lib/ab-shell.ts — 审核侧薄壳：仓库入口按槽令牌加载槽内实现
//
// 仓库里的扩展入口变成一层薄壳（见 docs/plans/2026-10-05-ab-update.md 第 4.5 / 4.6 节）：
//   槽在   → 加载槽内那份实现（它 import 的 lib 也落在槽里，整条链同版本）
//   槽不在 → 用仓库这份（首次使用、没上过槽、或别人机器上压根没这个引擎）
//   起不来 → 用仓库这份，并留一条提示（壳永远不该把 pi 弄死）
//
// 令牌那一环是实测来的结论（2026-10-05 探针）：动态 import 同一个路径字符串会被 URL 缓存吃掉，
// 换了软链还是旧模块；必须把随槽变化的令牌拼进查询串，换槽才真的换实现。

import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { activeDir, readManifestOf, tokenOf } from "./ab-tag.ts";
import { pathToFileURL } from "node:url";
import { componentInitialized, currentSlot, readManifest } from "./ab-store.ts";
import { slotPath, slotToken, type AbComponent } from "./ab-slots.ts";
import { appendCrashReport } from "./ab-crash-report.ts";
import { resolveRuntimeRoot, writeNotice } from "./ab-watch.ts";

export interface SlotLoadOutcome<T> {
	/** 拿到的模块命名空间（槽内那份或仓库那份） */
	module: T;
	/** 这份是从哪来的 */
	source: "slot" | "repo";
	/** 为什么退回仓库（source 为 repo 时总有值） */
	reason?: string;
	slot?: string;
	token?: string;
}

export interface SlotLoadOptions<T> {
	/** 槽内的相对路径：extensions/<名字>/index.ts */
	extension: string;
	/** 退回仓库时的加载方式，通常是 () => import("./impl.ts") */
	fallback: () => Promise<T>;
	/** 运行时根覆盖（测试用） */
	runtimeRoot?: string;
	/**
	 * 调用方自己的文件路径（壳入口传 fileURLToPath(import.meta.url)）。
	 *
	 * 用来挡住一种会无限递归的情形：槽里那份**就是壳本身**（打包时没把入口摊平）。
	 * 那种情况下再加载一次等于壳加载壳，会一直套下去。
	 */
	selfPath?: string;
}

/** 槽里那份能不能当扩展用：pi 要的是一个函数做 default */
function hasFactory(module: unknown): boolean {
	return Boolean(module) && typeof (module as { default?: unknown }).default === "function";
}

/**
	* 按槽加载实现。这个函数**不抛异常**：任何一步出问题都退回仓库那份，
	* 并把原因留在返回值与提示文件里。
	*/
export async function loadSlotExtension<T>(
	component: AbComponent,
	options: SlotLoadOptions<T>,
): Promise<SlotLoadOutcome<T>> {
	const fallback = async (reason: string): Promise<SlotLoadOutcome<T>> => ({
		module: await options.fallback(),
		source: "repo",
		reason,
	});

	let runtimeRoot: string;
	try {
		runtimeRoot = resolveRuntimeRoot(options.runtimeRoot);
	} catch (error) {
		return await fallback(`拿不到运行时根：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!componentInitialized(runtimeRoot, component)) {
		return await fallback("这个组件的运行时目录还没初始化");
	}
	// 新模型：一条产品线一个 tag，生效的是 tag/dir 指的那份。
	// 旧四槽（current 软链）在新状态没立起来时兜底，第 3 批删掉。
	const dir = activeDir(join(runtimeRoot, component));
	const legacySlot = dir === "" ? currentSlot(runtimeRoot, component) : undefined;
	const active = dir ? basename(dir) : legacySlot ? String(legacySlot) : "";
	const activePath = dir || (legacySlot ? slotPath(runtimeRoot, component, legacySlot) : "");
	if (!activePath) {
		return await fallback("既没有 tag 状态，也没有可用的 current 软链");
	}
	const slotFile = join(activePath, "extensions", options.extension, "index.ts");
	if (!existsSync(slotFile)) {
		return await fallback(`槽 ${active} 里没有 extensions/${options.extension}/index.ts`);
	}

	if (options.selfPath) {
		try {
			if (realpathSync(slotFile) === realpathSync(options.selfPath)) {
				return await fallback(`槽 ${active} 里那份就是壳本身，已退回仓库实现`);
			}
		} catch {
			// 比对不出结果就当不是壳，按正常路径继续
		}
	}

	const token = tokenOf(readManifestOf(activePath), active);
	const url = `${pathToFileURL(slotFile).href}?slot=${token}`;
	try {
		const loaded = (await import(url)) as T;
		if (!hasFactory(loaded)) {
			const reason = `槽 ${active} 里那份没有可用的 default 工厂`;
			writeNotice(runtimeRoot, component, `槽 ${active} 的 ${options.extension} ${reason}，已退回仓库版本`);
			// 退回仓库是"槽坏了"的信号：写一份报告，别让它只躺在状态目录里
			appendCrashReport({
				at: new Date().toISOString(),
				component,
				stage: "加载扩展",
				summary: `${options.extension}：${reason}`,
				module: slotFile,
				hint: `重打这个槽（make ab-pack COMPONENT=${component} SLOT=dev），或 make ab-detach COMPONENT=${component}`,
			});
			return await fallback(reason);
		}
		return { module: loaded, source: "slot", slot: active, token };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeNotice(runtimeRoot, component, `槽 ${active} 的 ${options.extension} 加载失败，已退回仓库版本：${message}`);
		appendCrashReport({
			at: new Date().toISOString(),
			component,
			stage: "加载扩展",
			summary: `${options.extension} 加载失败：${message}`,
			module: slotFile,
			error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message },
			context: { 槽: active, 扩展: options.extension },
			hint: `重打这个槽（make ab-pack COMPONENT=${component} SLOT=dev），或 make ab-detach COMPONENT=${component}`,
		});
		return await fallback(`槽 ${active} 里那份加载失败：${message}`);
	}
}
