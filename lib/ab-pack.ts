// lib/ab-pack.ts — 打包到槽：该做什么、允许做什么（纯函数）
//
// 分工同 ab-slots 与 ab-store：这里只判"这一步合不合法、manifest 该写什么"，
// 真正调 git / tar / vite 的活留给 scripts/ab-pack.ts。
//
// 两条硬规矩（见 docs/plans/2026-10-05-ab-update.md）：
//   1. 只往 dev / head 里构建：stable 与 previous 只由晋升与回退动，
//      否则"回退目标"就不再可靠
//   2. 脏工作区可以构建到 dev/head（狗粮本来就要试未提交的东西），但 manifest 记 dirty，
//      而脏的产物不允许晋升（除非 --force，且留痕）

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AB_COMPONENTS, AB_SLOTS, type AbComponent, type AbSlot, type SlotManifest } from "./ab-slots.ts";

/** 构建允许落在哪些槽 */
export const BUILDABLE_SLOTS: readonly AbSlot[] = ["dev", "head"];

/** 只有自举能把基线槽（stable/previous）铺出来；平时它们由晋升与回退动 */
export const BOOTSTRAP_SLOTS: readonly AbSlot[] = ["stable", "previous"];

export interface PackOptions {
	component: AbComponent;
	/** 构建来源：tag、sha 或 HEAD */
	ref: string;
	slot: AbSlot;
	/** 构建时工作区是否脏 */
	dirty: boolean;
	at: string;
	/** 该 ref 的提交 sha（取不到就不记） */
	sha?: string;
	/** gui 组件才有的协议信息（从槽内自报里读） */
	protocol?: number;
	windows?: string[];
	/** 自举：允许落 stable/previous，用来给"从零开始"铺一条可回退的基线 */
	bootstrap?: boolean;
}

export interface PackPlan {
	ok: boolean;
	reason?: string;
	manifest?: SlotManifest;
}

/** 校验一次构建请求；不合法时说明原因，不抛异常（CLI 负责打印） */
export function planPack(options: PackOptions): PackPlan {
	if (!AB_COMPONENTS.includes(options.component)) {
		return { ok: false, reason: `组件名必须是 ${AB_COMPONENTS.join(" | ")}` };
	}
	if (!AB_SLOTS.includes(options.slot)) {
		return { ok: false, reason: `槽名必须是 ${AB_SLOTS.join(" | ")}` };
	}
	const buildable: readonly AbSlot[] = options.bootstrap
		? [...BUILDABLE_SLOTS, ...BOOTSTRAP_SLOTS]
		: BUILDABLE_SLOTS;
	if (!buildable.includes(options.slot)) {
		const allowed = buildable.join(" / ");
		return { ok: false, reason: `${options.slot} 只由晋升与回退动，构建只能落 ${allowed}` };
	}
	const ref = options.ref.trim() === "" ? "HEAD" : options.ref.trim();
	const manifest: SlotManifest = {
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
export function canPromote(manifest: SlotManifest | undefined, options: { force?: boolean } = {}): { ok: boolean; reason: string } {
	if (!manifest) return { ok: false, reason: "dev 槽里没有 manifest，像是没构建过" };
	if (manifest.dirty && !options.force) {
		return { ok: false, reason: "dev 是脏工作区构建的，复现不出来（要强推加 --force）" };
	}
	return { ok: true, reason: "可以晋升" };
}

/** 槽里需要从 ref 取哪些路径：audit 要源码（jiti 直接跑 ts），gui 要窗口产物 */
export function archivePathsOf(component: AbComponent): string[] {
	return component === "audit" ? ["lib", "extensions"] : ["gui"];
}

/** 会把仓库入口做成壳的扩展：这些入口在槽里必须摊平 */
export const SHELLED_ENTRIES: readonly string[] = ["ptc", "sandbox-permissions"];

/**
 * 把槽里的壳入口摊平成对 impl 的重导出。
 *
 * 不摊平会无限递归：壳解析到槽 → 槽里的 index.ts 又是同一个壳 → 壳加载壳。
 * 只在确实看着像壳（提到 loadSlotExtension）且同目录有 impl.ts 时才动，别的入口不碰。
 */
export function flattenShellsInSlot(slotDir: string, entries: readonly string[] = SHELLED_ENTRIES): string[] {
	const flattened: string[] = [];
	for (const entry of entries) {
		const dir = join(slotDir, "extensions", entry);
		const impl = join(dir, "impl.ts");
		const index = join(dir, "index.ts");
		try {
			if (!existsSync(impl) || !existsSync(index)) continue;
			if (!readFileSync(index, "utf8").includes("loadSlotExtension")) continue;
			writeFileSync(index, `export { default } from "./impl.ts";\n`, "utf8");
			flattened.push(entry);
		} catch {
			// 摊平失败就留着原样：壳的自加载护栏会兜住（退回仓库实现，不递归）
		}
	}
	return flattened;
}
