// registry.ts — DSH dsh-jobs/dsh-jobs-local 移植：进程内后台任务注册表（纯 TS，零 pi 依赖）
//
// 语义照抄 @deepseek-ai/dsh-jobs（seam）+ dsh-jobs-local（内存实现）：
//   - 任务生命周期：running →（可选 stopping）→ 恰好一个终态 completed|killed|failed
//   - id = `<kind>-N`（注册序）
//   - read：流式任务返回自上次读取的增量；终态任务结算后幂等返回最终输出（终态读标记 reported）
//   - wait：等终态或超时，不取消任务；调用方 abort 仅取消等待本身
//   - kill：请求取消 → stopping → 生产者 done 结算为 killed；对已终态返回 already-finished
//   - 完成通知：first-wins，每任务一次（reported 位）；进程本地状态，重启即失（照抄 DSH）
//   - 简化（pi 单会话）：无 owner 隔离（DSH 按 session 栅栏），所有任务对所有调用方可见

export type JobStatus = "running" | "stopping" | "completed" | "killed" | "failed";

/** 生产者终态结果（DSH JobOutcome） */
export interface JobOutcome {
	status: "completed" | "killed" | "failed";
	/** kind 专属细节（'exit code: 3' 等） */
	detail?: string;
	/** 终态输出（流式任务不设） */
	output?: string;
}

/** 生产者声明（DSH JobStart） */
export interface JobStart {
	/** 任务种类——也是 id 前缀（bash / subagent / …） */
	kind: string;
	/** 一行模型可见标签（命令/委派描述） */
	label: string;
	/** 启动工作并同步返回 hooks；抛错则不留任何注册 */
	run(): JobHooks;
}

/** 运行时控制与观察生产者工作的 hooks（DSH JobHooks） */
export interface JobHooks {
	/** 请求终止；必须同步、幂等、最终 settle done；抛错向上传播 */
	cancel(reason?: string): void;
	/** 生产者释放资源后 resolve（不许 reject；runtime 转 failed） */
	done: Promise<JobOutcome>;
	/** 消费自上次以来的输出增量；缺省 = 仅终态输出任务 */
	readOutput?(): string;
}

/** 只读任务投影（每次调用新鲜对象，非活注册表状态；DSH JobSnapshot） */
export interface JobSnapshot {
	id: string;
	kind: string;
	label: string;
	status: JobStatus;
	detail?: string;
	startedAt: number;
	finishedAt?: number;
	/** 已报告位：kill/read/wait/teardown 已报告或承诺报告终态；完成通知据此去重 */
	reported: boolean;
}

/** read 返回：输出增量/终态输出 + 读时快照（DSH JobRead） */
export interface JobRead {
	text: string;
	snapshot: JobSnapshot;
}

export type JobDoneListener = (snapshot: JobSnapshot) => void | PromiseLike<void>;

interface JobRecord extends JobSnapshot {
	hooks: JobHooks;
	/** 流式游标：已消费字节 */
	readCursor: number;
	/** 已完成输出的缓存（终态任务结算后固定） */
	finalOutput?: string;
	/** 完成通知已投递（first-wins） */
	notified: boolean;
	/** 等待者队列（settle 时全部释放） */
	waiters: Array<(snap: JobSnapshot) => void>;
	/** 结算器：保证 first-wins（一个终态记录） */
	settled: boolean;
}

export class JobsError extends Error {
	readonly code: "JOB_NOT_FOUND" | "JOB_ALREADY_FINISHED";
	constructor(message: string, code: JobsError["code"]) {
		super(message);
		this.name = "JobsError";
		this.code = code;
	}
}

/** 进程内内存注册表（重启即失，照抄 DSH「进程本地状态不持久化」） */
export class JobRegistry {
	private records = new Map<string, JobRecord>();
	private seq = new Map<string, number>();
	private listeners = new Set<JobDoneListener>();

	/** 注册并启动一个任务（DSH start：预检后同步启动，注册不可失败） */
	start(spec: JobStart): string {
		const n = (this.seq.get(spec.kind) ?? 0) + 1;
		this.seq.set(spec.kind, n);
		const id = `${spec.kind}-${n}`;
		let hooks: JobHooks;
		try {
			hooks = spec.run();
		} catch (err) {
			throw err; // 生产者负责清理部分启动的资源；不留注册
		}
		const record: JobRecord = {
			id,
			kind: spec.kind,
			label: spec.label,
			status: "running",
			startedAt: Date.now(),
			reported: false,
			hooks,
			readCursor: 0,
			notified: false,
			waiters: [],
			settled: false,
		};
		this.records.set(id, record);
		this.observe(record);
		return id;
	}

	/** 注册序快照列表（DSH list） */
	list(): JobSnapshot[] {
		return Array.from(this.records.values()).map((r) => this.snapshotOf(r));
	}

	/** 单个快照（DSH get） */
	get(id: string): JobSnapshot {
		return this.snapshotOf(this.expect(id));
	}

	/** 读取输出增量或终态输出（DSH read；终态读标记 reported） */
	read(id: string): JobRead {
		const record = this.expect(id);
		let text: string;
		if (record.status === "completed" || record.status === "killed" || record.status === "failed") {
			// 终态：幂等返回最终输出（流式任务 = 全部累积，终态任务 = outcome.output）
			// 终态输出已在 observe 结算时固定（流式=全量累积，非流式=outcome.output）
			text = record.finalOutput ?? "";
			record.reported = true;
		} else {
			text = record.hooks.readOutput ? this.drainStream(record) : "";
		}
		return { text, snapshot: this.snapshotOf(record) };
	}

	/** 请求取消（DSH kill）；返回 requested | already-finished；终态报告位照抄 DSH */
	kill(id: string, reason?: string): "requested" | "already-finished" {
		const record = this.expect(id);
		if (this.isTerminal(record.status)) {
			record.reported = true;
			return "already-finished";
		}
		record.status = "stopping";
		record.detail = reason ?? record.detail;
		record.reported = true; // 报告终态承诺（照抄 DSH kill）
		try {
			record.hooks.cancel(reason);
		} catch {
			// 生产者取消抛错：不动状态（照抄 DSH）
		}
		return "requested";
	}

	/** 等待终态或超时（DSH wait）；不取消任务；终态返回标记 reported（照抄 DSH 258 行） */
	async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<JobSnapshot> {
		const record = this.expect(id);
		if (this.isTerminal(record.status)) {
			record.reported = true;
			return this.snapshotOf(record);
		}
		const snapshot = await new Promise<JobSnapshot>((resolve) => {
			const done = (): void => resolve(this.snapshotOf(record));
			record.waiters.push(done);
			const timer = setTimeout(() => {
				const idx = record.waiters.indexOf(done);
				if (idx >= 0) record.waiters.splice(idx, 1);
				resolve(this.snapshotOf(record));
			}, timeoutMs);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					const idx = record.waiters.indexOf(done);
					if (idx >= 0) record.waiters.splice(idx, 1);
					resolve(this.snapshotOf(record));
				},
				{ once: true },
			);
		});
		// 完成通知在 settle 时已按 reported 判重；这里在返回路径补置（DSH 语义）
		if (this.isTerminal(snapshot.status)) record.reported = true;
		return snapshot;
	}

	/** 注册完成监听（first-wins：每任务一次，reported 位去重；DSH onJobDone） */
	onJobDone(listener: JobDoneListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// ---------------------------------------------------------------------

	private expect(id: string): JobRecord {
		const record = this.records.get(id);
		if (!record) throw new JobsError(`job ${id} not found`, "JOB_NOT_FOUND");
		return record;
	}

	private snapshotOf(record: JobRecord): JobSnapshot {
		return {
			id: record.id,
			kind: record.kind,
			label: record.label,
			status: record.status,
			detail: record.detail,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			reported: record.reported,
		};
	}

	private drainStream(record: JobRecord): string {
		const output = record.hooks.readOutput ? record.hooks.readOutput() : "";
		const consumed = output.slice(record.readCursor);
		record.readCursor = output.length;
		return consumed;
	}

	private isTerminal(status: JobStatus): boolean {
		return status === "completed" || status === "killed" || status === "failed";
	}

	/** 观察生产者 done：first-wins 结算 + 通知 + 释放等待者 */
	private observe(record: JobRecord): void {
		record.hooks.done
			.then((outcome) => {
				if (record.settled) return; // first-wins
				record.settled = true;
				record.status = outcome.status;
				record.detail = outcome.detail ?? record.detail;
				record.finishedAt = Date.now();
				if (record.hooks.readOutput) {
					record.finalOutput = this.drainStream(record);
				} else {
					record.finalOutput = outcome.output ?? "";
				}
				// 释放等待者
				const waiters = record.waiters.splice(0);
				const snapshot = this.snapshotOf(record);
				for (const waiter of waiters) waiter(snapshot);
				// first-wins 完成通知（reported 已置位则跳过）
				if (!record.notified && !record.reported) {
					record.notified = true;
					for (const listener of this.listeners) {
						try {
							void listener(snapshot);
						} catch {
							/* listener contained */
						}
					}
				}
			})
			.catch(() => {
				if (record.settled) return;
				record.settled = true;
				record.status = "failed";
				record.detail = record.detail ?? "producer error";
				record.finishedAt = Date.now();
				record.finalOutput = "";
				const waiters = record.waiters.splice(0);
				const snapshot = this.snapshotOf(record);
				for (const waiter of waiters) waiter(snapshot);
			});
	}
}
