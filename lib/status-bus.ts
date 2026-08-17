// lib/status-bus.ts — 状态栏总线（两侧抽象）
//
// 在扩展与 pi 的状态栏之间注入一层：把「状态栏的所有信息」收进一个规范存储，
// 再从输出侧扇出到多个目标。对扩展而言仍是原生 ctx.ui 调用，零迁移、无感知。
//
// ── 结构（后续开发从这里找入口）──
// 左（输入）：attach(ui) 幂等地包住 ui 的 setStatus / setWidget / setWorking*，
//   记录进 store 后转发原生实现（= TUI 目标，行为不变）。
// 中（存储）：keyed Map，undefined 删键。
// 右（输出）：getSnapshot() 输出 JSON 契约快照；subscribe(listener) 订阅同一份
//   变更流 —— 未来 web / 文件 / 事件桥等目标都从这里接入，无需改扩展侧。
//
// ── 数据 / 渲染分离原则 ──
// 总线只承载「数据」，不承载「渲染」。渲染（着色、排版、顺序、是否显示）是前端
// （TUI 主题 或 web CSS/组件）的职责，不是共享层的职责。因此：
//   - statuses[*].text 存去 ANSI 的纯文本；TUI 的着色由 theme.fg 在透传那一刻完成，
//     web 侧拿纯文本自行渲染。
//   - 本层不做语义反解（如从颜色码猜 success/warning/accent）。将来若需要语义级
//     着色，应由扩展提供结构化状态字段（text + level），而不是让本层猜测。
//     （结构化状态契约草案见 extensions/status-bus/README.md「演进草案」，未实现）
//
// ── JSON 契约（web / 外部消费方从这里开始读）──
// getSnapshot() 的产物 100% 可 JSON.stringify。唯一不直接可序列化的「组件工厂」
// （setWidget 传函数）被归一化为 { kind: "factory", serialized: false } 占位标记，
// string[] 归一化为 { kind: "lines", lines: [...] }。web 团队只消费 WidgetPayload
// 的 kind 判别即可，无需关心 TUI 组件实现。契约全文与示例见
// extensions/status-bus/README.md。
//
// 已知边界：扩展加载顺序 = readdirSync（非字母序、不可控），attach 可能晚于少数
//   扩展的 session_start 首轮写入；这些初始状态进不了 store（TUI 显示不受影响）。
//   后续若要完整初始快照，可在目标侧做一次 reconcile（见 README）。

// ── 输出侧 JSON 契约类型（web/外部消费方的输入面）────────────────────────

/**
 * 状态栏单项（setStatus）。
 * text 为去 ANSI 的纯文本数据（渲染是前端的职责，本层只存数据，不存着色）。
 */
export interface StatusEntry {
	text: string;
	updatedAt: number;
}

/** 编辑器挂件挂载位置（对应 pi WidgetPlacement 的可序列化子集） */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** setWidget 的 options（JSON 安全） */
export interface WidgetOptions {
	placement?: WidgetPlacement;
}

/**
 * 编辑器挂件内容（输出侧 JSON 契约，用 kind 判别）：
 * - "lines"   → setWidget(key, string[]) 的文本行，web 直接渲染
 * - "factory" → setWidget(key, componentFactory) 的 TUI 组件工厂；函数不可序列化，
 *               web 端无等效，应走声明式 openPanel。serialized:false 为显式占位标记，
 *               note 说明原因，供 web 团队决定降级策略。
 */
export type WidgetPayload =
	| { kind: "lines"; lines: string[] }
	| { kind: "factory"; serialized: false; note: string };

/** 编辑器挂件单项（setWidget） */
export interface WidgetEntry {
	content: WidgetPayload;
	options?: WidgetOptions;
	updatedAt: number;
}

/** 工作指示器（JSON 安全；pi WorkingIndicatorOptions 的可序列化子集） */
export interface WorkingIndicatorPayload {
	frames?: string[];
	intervalMs?: number;
}

/** 工作指示器状态（setWorkingMessage / setWorkingVisible / setWorkingIndicator） */
export interface WorkingState {
	message?: string;
	visible?: boolean;
	indicator?: WorkingIndicatorPayload;
}

/** 总线快照：JSON 契约的根对象，可直接 JSON.stringify / 交给 web 消费 */
export interface StatusSnapshot {
	version: number;
	statuses: Record<string, StatusEntry>;
	widgets: Record<string, WidgetEntry>;
	working: WorkingState;
}

// ── 变更流（未来输出目标的接入点）────────────────────────────────────────

export type StatusChangeKind = "status" | "widget" | "working" | "reset";

export interface StatusChange {
	kind: StatusChangeKind;
	/** status / widget 变化时的 key；working / reset 无 key */
	key?: string;
	snapshot: StatusSnapshot;
}

export type StatusListener = (change: StatusChange) => void;

// ── 输入侧最小结构面（attach 包装的 ctx.ui 子集）─────────────────────────

/** attach 需要的最小结构面（ctx.ui 的子集；签名放宽为 unknown 以便重赋值包装） */
export interface StatusUI {
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: unknown, options?: unknown): void;
	setWorkingMessage(message?: string): void;
	setWorkingVisible(visible: boolean): void;
	setWorkingIndicator(options?: unknown): void;
}

// ── 归一化助手：把 TUI 原生入参折叠成 JSON 安全形态 ───────────────────────

const FACTORY_NOTE =
	"TUI 组件工厂，函数不可序列化；web 端无等效，应走声明式 openPanel";

/** 去 ANSI 转义序列（CSI），保留纯文本。着色/排版交给前端，本层只存数据。 */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** setWidget 内容 → WidgetPayload（string[] 与函数以外的形状按非序列化占位处理） */
function normalizeWidget(content: unknown): WidgetPayload {
	if (Array.isArray(content)) {
		return { kind: "lines", lines: content.filter((l): l is string => typeof l === "string") };
	}
	if (typeof content === "function") {
		return { kind: "factory", serialized: false, note: FACTORY_NOTE };
	}
	return { kind: "factory", serialized: false, note: `未知 widget 内容类型：${typeof content}` };
}

/** setWidget options → WidgetOptions（仅保留可序列化的 placement） */
function normalizeWidgetOptions(options: unknown): WidgetOptions | undefined {
	if (typeof options !== "object" || options === null) return undefined;
	const placement = (options as { placement?: unknown }).placement;
	if (placement === "aboveEditor" || placement === "belowEditor") return { placement };
	return undefined;
}

/** setWorkingIndicator options → WorkingIndicatorPayload（过滤非字符串帧） */
function normalizeIndicator(options: unknown): WorkingIndicatorPayload | undefined {
	if (typeof options !== "object" || options === null) return undefined;
	const { frames, intervalMs } = options as { frames?: unknown; intervalMs?: unknown };
	if (!Array.isArray(frames) && typeof intervalMs !== "number") return undefined;
	const out: WorkingIndicatorPayload = {};
	if (Array.isArray(frames)) out.frames = frames.filter((f): f is string => typeof f === "string");
	if (typeof intervalMs === "number") out.intervalMs = intervalMs;
	return out;
}

// ── 总线实现 ──────────────────────────────────────────────────────────────

export class StatusBus {
	private statuses = new Map<string, StatusEntry>();
	private widgets = new Map<string, WidgetEntry>();
	private working: WorkingState = {};
	private listeners = new Set<StatusListener>();
	private wrapped = new WeakSet<object>();
	private version = 0;

	getSnapshot(): StatusSnapshot {
		return {
			version: this.version,
			statuses: Object.fromEntries(this.statuses),
			widgets: Object.fromEntries(this.widgets),
			working: { ...this.working },
		};
	}

	/** 订阅变更流；返回退订函数。未来输出目标（web/文件/事件桥）从这里接入。 */
	subscribe(listener: StatusListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** 清空当前会话的状态（session_shutdown / reload 时调用）。不动 wrapped，避免重 wrap。 */
	reset(): void {
		this.statuses.clear();
		this.widgets.clear();
		this.working = {};
		this.bump();
		this.emit({ kind: "reset", snapshot: this.getSnapshot() });
	}

	/** 幂等地把 ui 接入总线：包装 setStatus/setWidget/setWorking*（记录后转发原生 = TUI 目标） */
	attach(ui: StatusUI): boolean {
		if (this.wrapped.has(ui)) return false;
		this.wrapped.add(ui);

		const setStatus = ui.setStatus.bind(ui);
		const setWidget = ui.setWidget.bind(ui);
		const setWorkingMessage = ui.setWorkingMessage.bind(ui);
		const setWorkingVisible = ui.setWorkingVisible.bind(ui);
		const setWorkingIndicator = ui.setWorkingIndicator.bind(ui);

		ui.setStatus = (key: string, text: string | undefined): void => {
			if (text === undefined) this.statuses.delete(key);
			// store 存去 ANSI 的纯数据；转发仍用原始 text（TUI 目标保留着色）
			else this.statuses.set(key, { text: stripAnsi(text), updatedAt: Date.now() });
			this.bump();
			this.emit({ kind: "status", key, snapshot: this.getSnapshot() });
			setStatus(key, text);
		};

		ui.setWidget = (key: string, content: unknown, options?: unknown): void => {
			if (content === undefined) this.widgets.delete(key);
			else {
				this.widgets.set(key, {
					content: normalizeWidget(content),
					options: normalizeWidgetOptions(options),
					updatedAt: Date.now(),
				});
			}
			this.bump();
			this.emit({ kind: "widget", key, snapshot: this.getSnapshot() });
			setWidget(key, content, options);
		};

		ui.setWorkingMessage = (message?: string): void => {
			if (message === undefined) delete this.working.message;
			else this.working.message = message;
			this.bump();
			this.emit({ kind: "working", snapshot: this.getSnapshot() });
			setWorkingMessage(message);
		};

		ui.setWorkingVisible = (visible: boolean): void => {
			this.working.visible = visible;
			this.bump();
			this.emit({ kind: "working", snapshot: this.getSnapshot() });
			setWorkingVisible(visible);
		};

		ui.setWorkingIndicator = (options?: unknown): void => {
			const normalized = normalizeIndicator(options);
			if (normalized === undefined) delete this.working.indicator;
			else this.working.indicator = normalized;
			this.bump();
			this.emit({ kind: "working", snapshot: this.getSnapshot() });
			setWorkingIndicator(options);
		};

		return true;
	}

	private bump(): void {
		this.version += 1;
	}

	private emit(change: StatusChange): void {
		for (const listener of this.listeners) {
			try {
				listener(change);
			} catch {
				// 订阅者异常不影响总线与 TUI 透传
			}
		}
	}
}

/** 进程级单例：跨事件共享同一份状态（reload 若重载模块则新实例从空开始，语义仍正确） */
export const statusBus = new StatusBus();
