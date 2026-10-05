// lib/ab-pack.ts — 打包：该做什么、允许做什么（纯函数）
//
// 这里只判"这一步合不合法、manifest 该写什么"，真正调 git / tar / vite 的活留给
// scripts/ab-pack.ts。
//
// 压缩后的模型只有一条规矩：**构建只落暂存目录**（dev）。生效的版本由 tag 切换，
// 回退目标是 prev-tag——不再有"哪个槽能构建"这套四槽词汇。
// 脏工作区可以构建（狗粮本来就要试未提交的东西），但 manifest 记 dirty。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AB_COMPONENTS, componentPath, formatManifest, type AbComponent, type BuildManifest } from "./ab-tag.ts";

/** 唯一的构建落点：暂存目录。生效与否由 tag 决定 */
export const BUILD_DIR = "dev";

export interface PackOptions {
	component: AbComponent;
	/** 构建来源：tag、sha 或 HEAD */
	ref: string;
	/** 构建落点，缺省就是暂存目录 dev */
	dir?: string;
	/** 构建时工作区是否脏 */
	dirty: boolean;
	at: string;
	/** 该 ref 的提交 sha（取不到就不记） */
	sha?: string;
	/** gui 组件才有的协议信息（从槽内自报里读） */
	protocol?: number;
	windows?: string[];
}

export interface PackPlan {
	ok: boolean;
	reason?: string;
	manifest?: BuildManifest;
}

/** 校验一次构建请求；不合法时说明原因，不抛异常（CLI 负责打印） */
export function planPack(options: PackOptions): PackPlan {
	if (!AB_COMPONENTS.includes(options.component)) {
		return { ok: false, reason: `组件名必须是 ${AB_COMPONENTS.join(" | ")}` };
	}
	const dir = options.dir ?? BUILD_DIR;
	if (dir !== BUILD_DIR) {
		return {
			ok: false,
			reason: `构建只能落暂存目录 ${BUILD_DIR}；要生效的版本就切 tag（make ab-update）`,
		};
	}
	const ref = options.ref.trim() === "" ? "HEAD" : options.ref.trim();
	const manifest: BuildManifest = {
		ref,
		...(options.sha ? { sha: options.sha } : {}),
		dirty: options.dirty,
		builtAt: options.at,
		...(options.protocol !== undefined ? { protocol: options.protocol } : {}),
		...(options.windows && options.windows.length > 0 ? { windows: options.windows } : {}),
	};
	return { ok: true, manifest };
}

/**
	* 这份 manifest 允不允许被晋升。
	*
	* 脏的产物事后复现不出来，所以默认拒绝；要强推走 --force 并留痕。
	*/
export function canPromote(manifest: BuildManifest | undefined, options: { force?: boolean } = {}): { ok: boolean; reason: string } {
	if (!manifest) return { ok: false, reason: "dev 槽里没有 manifest，像是没构建过" };
	if (manifest.dirty && !options.force) {
		return { ok: false, reason: "dev 是脏工作区构建的，复现不出来（要强推加 --force）" };
	}
	return { ok: true, reason: "可以晋升" };
}

/**
 * 槽里需要从 ref 取哪些路径。
 *
 * 现在只有 gui 一条产线：它是窗口产物，要整槽原子切换。
 * 审核侧（扩展）不再走 A/B——改的是仓库那份，/reload 就生效。
 */
export function archivePathsOf(component: AbComponent): string[] {
	void component;
	return ["gui"];
}

// 壳（按槽加载实现）已撤：扩展入口直接重导出 impl.ts，槽里不再放带壳的副本。
// 于是也没有"摊平入口"这一步——那是壳存在时才需要防的自加载递归。
