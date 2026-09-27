// lib/fragment-providers.ts — 动态碎片的注册挂点
//
// extensions/fragments 只负责「扫到 `&名字(参数)` 就交给谁展开」，不关心展开逻辑本身。
// 手里有动态内容的扩展（照片编号、当前分支、临时文件清单……）自己往这里注册一个 provider，
// 这样多一种动态引用就多一个注册点，不用往 fragments 里塞业务分支，也不用为了发布新引用改它。
//
// 单例做法：必须挂到 globalThis（见 lib/process-singleton.ts）。pi 给每个扩展单独建 jiti 实例，
// 模块级变量在扩展之间不共享 —— 这里曾经写成模块级 Map，结果 photo 注册的 `img` provider
// 在 fragments 侧永远看不见，`&img(…)` 一律不展开。
// reload 时模块会被重新求值，但 globalThis 上那份不变，各扩展的 factory 重新注册即可。

import type { ImageContent } from "@earendil-works/pi-ai";
import { processSingleton } from "./process-singleton.ts";

/**
 * provider 展开一次的结果。
 * text 进正文（可以是空串，比如「只把图附上」），images 按出现顺序附到这条消息上。
 */
export interface FragmentCallResult {
	text: string;
	images?: ImageContent[];
}

export interface FragmentProvider {
	/** 触发词，与 fragments.toml 里的名字共用一套字符集（字母、数字、下划线、连字符、冒号） */
	name: string;
	/**
	 * args 是括号里的原文（`&img(3)` → `"3"`）；不带括号的调用传空串。
	 * 返回 undefined 表示「这个名字/参数我认不了」，由 fragments 按未知名字处理（原文保留 + 提示）。
	 * 可以返回 Promise：展开是异步做的，扫描那一趟会 await。
	 */
	expand(args: string): FragmentCallResult | undefined | Promise<FragmentCallResult | undefined>;
}

const providers = processSingleton<Map<string, FragmentProvider>>("fragment-providers", () => new Map());

/**
 * 注册（或覆盖）一个 provider。
 * 同名后注册的覆盖前者、不抛错：扩展 reload 会重跑 factory，重注册是正常路径而不是错误。
 */
export function registerFragmentProvider(provider: FragmentProvider): void {
	providers.set(provider.name, provider);
}

export function lookupFragmentProvider(name: string): FragmentProvider | undefined {
	return providers.get(name);
}

/** 清空注册表。测试隔离用；生产里 reload 会重新注册，不需要手动清 */
export function clearFragmentProviders(): void {
	providers.clear();
}
