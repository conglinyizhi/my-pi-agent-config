// lib/status-bus.ts — 状态栏总线（两侧抽象）
//
// 在扩展与 pi 的状态栏之间注入一层：把「状态栏的所有信息」收进一个规范存储，
// 再从输出侧扇出到多个目标。对扩展而言仍是原生 ctx.ui 调用，零迁移、无感知。
//
// 左（输入）：attach(ui) 幂等地包住 ui 的 setStatus / setWidget / setWorking*，
//   记录进 store 后转发原生实现（= TUI 目标，行为不变）。
// 中（存储）：keyed Map，undefined 删键；getSnapshot() 输出可序列化快照。
// 右（输出）：subscribe(listener) 订阅同一份变更流 —— 未来 web / 文件 / 事件桥
//   等目标都从这里接入，无需改扩展侧或这里。
//
// 已知边界：扩展加载顺序 = readdirSync（非字母序、不可控），attach 可能晚于少数
//   扩展的 session_start 首轮写入；这些初始状态进不了 store（TUI 显示不受影响）。
//   后续若要完整初始快照，可在目标侧做一次 reconcile（见 README）。

/** 状态栏单项（setStatus） */
export interface StatusEntry {
	text: string;
	updatedAt: number;
}

/** 编辑器挂件单项（setWidget）；content 为 string[] 或组件工厂函数 */
export interface WidgetEntry {
	content: unknown;
	options?: unknown;
	updatedAt: number;
}

/** 工作指示器状态（setWorkingMessage / setWorkingVisible / setWorkingIndicator） */
export interface WorkingState {
	message?: string;
	visible?: boolean;
	indicator?: unknown;
}

/** 总线快照：可序列化（除 widget 的组件工厂 content，web 目标后续自行处理） */
export interface StatusSnapshot {
	version: number;
	statuses: Record<string, StatusEntry>;
	widgets: Record<string, WidgetEntry>;
	working: WorkingState;
}

export type StatusChangeKind = "status" | "widget" | "working" | "reset";

export interface StatusChange {
	kind: StatusChangeKind;
	/** status / widget 变化时的 key；working / reset 无 key */
	key?: string;
	snapshot: StatusSnapshot;
}

export type StatusListener = (change: StatusChange) => void;

/** attach 需要的最小结构面（ctx.ui 的子集；签名放宽为 unknown 以便重赋值包装） */
export interface StatusUI {
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: unknown, options?: unknown): void;
	setWorkingMessage(message?: string): void;
	setWorkingVisible(visible: boolean): void;
	setWorkingIndicator(options?: unknown): void;
}

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
			else this.statuses.set(key, { text, updatedAt: Date.now() });
			this.bump();
			this.emit({ kind: "status", key, snapshot: this.getSnapshot() });
			setStatus(key, text);
		};

		ui.setWidget = (key: string, content: unknown, options?: unknown): void => {
			if (content === undefined) this.widgets.delete(key);
			else this.widgets.set(key, { content, options, updatedAt: Date.now() });
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
			if (options === undefined) delete this.working.indicator;
			else this.working.indicator = options;
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
