// lib/ab-slots.ts — A/B 更新引擎的槽位逻辑（纯函数，fs 留给调用方）
//
// 四个槽按角色分：stable 是当前稳定版，previous 是回退目标，dev 是正在攒干净往返的候选，
// head 是从工作区现构的应急试跑位。
//
// 为什么必须四槽：只要允许自动晋升，就得有 previous 接住被顶下来的 stable。
// 否则第 N+1 次跑出问题时，回退目标已经被换成那个坏版本了。
//
// 这里只算"该做什么"，不碰文件系统：软链、rename、写日志都由 CLI 去做，
// 于是这套规则能被单测钉住，而真正动盘的那段永远只有几行。

export type AbComponent = "gui" | "audit";
export const AB_COMPONENTS: readonly AbComponent[] = ["gui", "audit"];

export type AbSlot = "stable" | "previous" | "dev" | "head";
export const AB_SLOTS: readonly AbSlot[] = ["stable", "previous", "dev", "head"];

/** 达标门槛：连续这么多次干净往返才允许晋升（提督 2026-10-05 定） */
export const DEFAULT_THRESHOLD = 5;

/** 看门狗门槛：连续这么多次失败就自动回退（连续比累计有意义：偶发一次不算毛） */
export const DEFAULT_FAIL_THRESHOLD = 3;

/** 默认运行时根目录（与 preshell 的 A/B 安装同一个地方） */
export const DEFAULT_RUNTIME_ROOT = "~/.pi/runtime";

export function isComponent(value: unknown): value is AbComponent {
	return typeof value === "string" && (AB_COMPONENTS as readonly string[]).includes(value);
}

export function isSlot(value: unknown): value is AbSlot {
	return typeof value === "string" && (AB_SLOTS as readonly string[]).includes(value);
}

/** 组件目录：<runtime>/<component>/ */
export function componentPath(runtimeRoot: string, component: AbComponent): string {
	return `${trimSlash(runtimeRoot)}/${component}`;
}

/** 某个槽的目录 */
export function slotPath(runtimeRoot: string, component: AbComponent, slot: AbSlot): string {
	return `${componentPath(runtimeRoot, component)}/${slot}`;
}

/** current 软链的路径：指谁就跑谁 */
export function currentLink(runtimeRoot: string, component: AbComponent): string {
	return `${componentPath(runtimeRoot, component)}/current`;
}

/** 晋升日志 */
export function promoteLogPath(runtimeRoot: string, component: AbComponent): string {
	return `${componentPath(runtimeRoot, component)}/promote.log`;
}

/** 计数状态文件 */
export function streakPath(runtimeRoot: string, component: AbComponent): string {
	return `${componentPath(runtimeRoot, component)}/streak.json`;
}

function trimSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

export interface SlotManifest {
	/** 构建来源的 git ref（tag 名或 sha） */
	ref?: string;
	sha?: string;
	/** 构建时工作区是否脏（脏的产物事后复现不出来） */
	dirty?: boolean;
	builtAt?: string;
	/** 该组件的协议能力摘要：换了槽就要跟着变，薄壳拿它当缓存令牌 */
	spec?: string;
	/** 构建时的协议版本与窗口清单：会话启动时靠它给提示，不必为了问一句去起 Electron */
	protocol?: number;
	windows?: string[];
}

export function parseManifest(text: string): SlotManifest | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object") return undefined;
		return parsed as SlotManifest;
	} catch {
		return undefined;
	}
}

export function formatManifest(manifest: SlotManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
	* 薄壳 import 槽内实现时带的令牌。
	*
	* 实测（2026-10-05 探针）：动态 import 同一个路径字符串会被 URL 缓存吃掉，
	* 换了软链也还是旧模块。所以令牌必须随槽变化——用它拼在 import 的查询串上。
	*/
export function slotToken(manifest: SlotManifest | undefined): string {
	if (!manifest) return "none";
	const parts = [manifest.sha ?? manifest.ref ?? "unknown", manifest.builtAt ?? "", manifest.spec ?? ""];
	return parts.join("-").replace(/[^A-Za-z0-9._-]/g, "_");
}

export interface StreakState {
	/** 正在攒计数的是哪个槽 */
	slot: AbSlot;
	/** 连续干净次数：达标即晋升，任一次失败清零 */
	clean: number;
	/** 连续失败次数：看门狗按它判回退，任一次干净清零 */
	failing?: number;
	/** 累计失败次数（不清零，便于事后看这段有多毛） */
	failures: number;
	lastAt?: string;
	lastReason?: string;
}

export function emptyStreak(slot: AbSlot = "dev"): StreakState {
	return { slot, clean: 0, failing: 0, failures: 0 };
}

export function parseStreak(text: string): StreakState {
	try {
		const parsed = JSON.parse(text) as Partial<StreakState>;
		const slot = isSlot(parsed.slot) ? parsed.slot : "dev";
		return {
			slot,
			clean: typeof parsed.clean === "number" && parsed.clean >= 0 ? parsed.clean : 0,
			failing: typeof parsed.failing === "number" && parsed.failing >= 0 ? parsed.failing : 0,
			failures: typeof parsed.failures === "number" && parsed.failures >= 0 ? parsed.failures : 0,
			...(typeof parsed.lastAt === "string" ? { lastAt: parsed.lastAt } : {}),
			...(typeof parsed.lastReason === "string" ? { lastReason: parsed.lastReason } : {}),
		};
	} catch {
		return emptyStreak();
	}
}

export function formatStreak(state: StreakState): string {
	return `${JSON.stringify(state, null, 2)}\n`;
}

/** 记一次往返结果：干净则累加，失败则清零重来（原因留着） */
export function streakAfter(
	state: StreakState,
	outcome: "clean" | "failure",
	options: { now?: string; reason?: string } = {},
): StreakState {
	const at = options.now;
	if (outcome === "clean") {
		// 干净一次就把失败连胜清掉：偶发一次失败不该攒成回退理由
		return { ...state, clean: state.clean + 1, failing: 0, ...(at ? { lastAt: at } : {}) };
	}
	return {
		...state,
		clean: 0,
		failing: (state.failing ?? 0) + 1,
		failures: state.failures + 1,
		...(at ? { lastAt: at } : {}),
		...(options.reason ? { lastReason: options.reason } : {}),
	};
}

export type PromotionDecision = "promote" | "notify" | "keep";

/** 达标之后自不自动切：autoPromote 打开就切，关掉只提示 */
export function decidePromotion(
	state: StreakState,
	options: { threshold?: number; autoPromote?: boolean } = {},
): { action: PromotionDecision; reason: string } {
	const threshold = options.threshold ?? DEFAULT_THRESHOLD;
	if (threshold <= 0) return { action: "keep", reason: "门槛非正数，不晋升" };
	if (state.clean < threshold) {
		return { action: "keep", reason: `干净往返 ${state.clean}/${threshold}，还差 ${threshold - state.clean} 次` };
	}
	return options.autoPromote === false
		? { action: "notify", reason: `已攒够 ${threshold} 次干净往返，等你点头晋升` }
		: { action: "promote", reason: `已攒够 ${threshold} 次干净往返，自动晋升` };
}

/**
 * 自检结果对计数的影响（与"真的一次审核往返"分开记）。
 *
 * 自检成功**不**增加 clean：晋升连胜要的是"人真的用过几次"，不是机器自己敲了几下。
 * 自检失败**要**增加 failing：GUI 起不来就是起不来，看门狗该按它算账；成功则把连胜清零，
 * 因为一个能起来的窗口说明这条链刚刚是活的。
 */
export function healthAfter(state: StreakState, ok: boolean, options: { now?: string; reason?: string } = {}): StreakState {
	const at = options.now;
	if (ok) {
		return { ...state, failing: 0, ...(at ? { lastAt: at } : {}) };
	}
	return {
		...state,
		failing: (state.failing ?? 0) + 1,
		failures: state.failures + 1,
		...(at ? { lastAt: at } : {}),
		...(options.reason ? { lastReason: options.reason } : {}),
	};
}

export interface RollbackDecision {
	action: "rollback" | "keep";
	reason: string;
}

/**
 * 看门狗的判定：连续失败到门槛就回退到 previous。
 *
 * 三条"不退"：没到门槛、已经在 previous 上（再退就是套娃）、压根没有 previous 槽。
 * 用的都是连续失败数，不是累计：累计会把「三天前崩过两次、今天崩一次」也算成一串。
 */
export function decideRollback(
	state: StreakState,
	options: { threshold?: number; hasPrevious?: boolean; currentIsPrevious?: boolean } = {},
): RollbackDecision {
	const threshold = options.threshold ?? DEFAULT_FAIL_THRESHOLD;
	const failing = state.failing ?? 0;
	if (threshold <= 0) return { action: "keep", reason: "看门狗门槛非正数，不回退" };
	if (failing < threshold) return { action: "keep", reason: `连续失败 ${failing}/${threshold}` };
	if (options.currentIsPrevious) return { action: "keep", reason: "已经在 previous 上了，不再往下退" };
	if (options.hasPrevious === false) return { action: "keep", reason: "没有可回退的槽" };
	return { action: "rollback", reason: `连续失败 ${failing} 次，回退到 previous` };
}

export type SlotActionKind = "move" | "link" | "log";

export interface SlotAction {
	kind: SlotActionKind;
	from?: AbSlot;
	to?: AbSlot;
	text?: string;
}

/**
	* 晋升：dev 升为 stable，旧 stable 降为 previous，current 指向 stable。
	*
	* 顺序要紧：先把旧 stable 挪到 previous，再让 dev 覆盖 stable——
	* 反过来会把唯一的回退目标冲掉。
	*/
export function planPromotion(options: { current?: AbSlot; at?: string; note?: string } = {}): SlotAction[] {
	return [
		// 1. 旧 stable → previous（先腾出 previous）
		{ kind: "move", from: "stable", to: "previous" },
		// 2. dev → stable
		{ kind: "move", from: "dev", to: "stable" },
		// 3. current 指向 stable（dev 的内容就是现在的 stable，名字归位而已）
		{ kind: "link", to: "stable" },
		{
			kind: "log",
			text: JSON.stringify({
				event: "promote",
				from: options.current ?? "dev",
				to: "stable",
				...(options.at ? { at: options.at } : {}),
				...(options.note ? { note: options.note } : {}),
			}),
		},
	];
}

/** 回退：current 指回 previous。就这一件事——回退路径越短越救得了命 */
export function planRollback(options: { at?: string; reason?: string } = {}): SlotAction[] {
	return [
		{ kind: "link", to: "previous" },
		{
			kind: "log",
			text: JSON.stringify({
				event: "rollback",
				to: "previous",
				...(options.at ? { at: options.at } : {}),
				...(options.reason ? { reason: options.reason } : {}),
			}),
		},
	];
}
