// lib/process-singleton.ts — 跨扩展共享状态的唯一正确写法
//
// ── 为什么需要它 ──────────────────────────────────────────────
// pi 给每个扩展单独建一个 jiti 实例（见 pi 的 core/extensions/loader.js：
// loadExtensionModule 里 `createJitiImpl(..., { moduleCache: false })`），
// 于是**同一个 lib 模块在每个扩展里各求值一份**，模块级变量不共享。
//
// 实测（真 pi 进程里探针）：photo 扩展注册的 `img` provider，
// fragments 侧永远看不见，`&img(1)` 因此永远不展开；而在同一个模块图里
// 注册再查就正常。所以「模块级单例 = 进程内单例」这个假设在 pi 里是错的。
//
// ── 怎么用 ────────────────────────────────────────────────────
// 任何**需要跨扩展共享**的状态都挂到 globalThis 上，键用 Symbol.for 保证
// 同名唯一（同一进程内、无论模块被求值多少次，拿到的都是同一份）：
//
//   const providers = processSingleton("fragment-providers", () => new Map<string, P>());
//
// 模块自己的 reset()/clear() 要**清空内容**而不是换引用，否则会把别人的那份丢掉：
//
//   export function clearFragmentProviders(): void { providers.clear(); }
//
// 不需要共享的东西别放这儿：纯函数、常量表、只是给本扩展用的缓存，留在模块里就行。

/** 键前缀，避免与进程里别的库撞名 */
const KEY_PREFIX = "pi-agent:";

/**
 * 取进程内唯一的一份状态；不存在就用 create() 建一份并记住。
 *
 * @param key 语义化的键名，同一份状态在所有调用点必须一致
 * @param create 首次创建；只会被调用一次
 */
export function processSingleton<T>(key: string, create: () => T): T {
	const symbol = Symbol.for(KEY_PREFIX + key);
	const store = globalThis as unknown as Record<symbol, T | undefined>;
	const existing = store[symbol];
	if (existing !== undefined) return existing;
	const value = create();
	store[symbol] = value;
	return value;
}

/** 仅供测试：丢掉这个键上的共享状态（下次 processSingleton 会重建一份） */
export function resetProcessSingleton(key: string): void {
	const symbol = Symbol.for(KEY_PREFIX + key);
	delete (globalThis as unknown as Record<symbol, unknown>)[symbol];
}
