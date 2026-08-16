// state.ts — DSH dsh-goal 领域移植：事件溯源状态机 + CAS + 折叠（纯 TS，零 pi 依赖）
//
// 语义照抄 @deepseek-ai/dsh-goal（types/runtime/fold/domain）：
//   - 同会话唯一「当前目标」，状态机 phase: active | paused | blocked | complete
//   - 每次变更追加全量快照事件（goal/change，last-wins）；clear 写 tombstone（revision+1）
//   - GoalRef {id, revision} 做 compare-and-set：陈旧引用抛 GOAL_STALE_REVISION
//   - roundsStarted 是 durable 的 Round 准入计数（由 goal round 消息折叠而来，不写快照）；
//     activation（armed/disarmed）是进程本地位，绝不持久化
//   - 转换规则（照抄 DSH）：
//       create  仅当前无目标或 phase==='complete'；revision=1, active, rounds 0, armed
//       edit    至少一个字段；revision+1；保 phase/blocker/activation
//       pause   active → paused, disarmed
//       resume  active/paused/blocked → active, armed；要求 rounds < maxGoalRounds；
//               active+armed 时拒绝（防重复 resume）
//       complete active/paused/blocked → complete, disarmed
//       block   active → blocked（附 reason），disarmed
//       clear   任意 phase → tombstone(revision+1)，disarmed

import { randomUUID } from "node:crypto";

/** 目标 id（品牌字符串） */
export type GoalId = string & { __goalId: true };

export function GoalId(raw: string): GoalId {
	return raw as GoalId;
}

/** CAS 标识：一次精确修订 */
export interface GoalRef {
	readonly id: GoalId;
	readonly revision: number;
}

export type GoalPhase = "active" | "paused" | "blocked" | "complete";

export interface GoalBlockReason {
	/** 稳定 lower-kebab-case 分类码 */
	readonly code: string;
	/** 非空说明 */
	readonly message: string;
}

/** 每次非 clear 变更写入的完整持久状态 */
export interface GoalSnapshot extends GoalRef {
	readonly objective: string;
	readonly phase: GoalPhase;
	readonly blockedReason?: GoalBlockReason;
	readonly maxGoalRounds: number;
}

/** 进程本地续行资格；绝不持久化 */
export type GoalActivation = "armed" | "disarmed";

/** 当前目标视图（含折叠计数与进程本地激活） */
export interface GoalView extends GoalSnapshot {
	readonly roundsStarted: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly activation: GoalActivation;
}

/** durable 变更（DSH GoalChangeMeta） */
export type GoalChange =
	| {
			kind: "goal/change";
			version: 1;
			operation: "create" | "edit" | "pause" | "resume" | "complete" | "block";
			goal: GoalSnapshot;
			roundsStarted: number;
			createdAt: number;
			updatedAt: number;
	  }
	| {
			kind: "goal/change";
			version: 1;
			operation: "clear";
			cleared: GoalRef;
			clearedAt: number;
	  };

/** 稳定错误码（DSH GoalErrorCode） */
export type GoalErrorCode =
	| "GOAL_NOT_FOUND"
	| "GOAL_ALREADY_EXISTS"
	| "GOAL_STALE_REVISION"
	| "GOAL_INVALID_OBJECTIVE"
	| "GOAL_INVALID_MAX_ROUNDS"
	| "GOAL_INVALID_BLOCK_REASON"
	| "GOAL_INVALID_EDIT"
	| "GOAL_INVALID_TRANSITION";

export class GoalError extends Error {
	readonly code: GoalErrorCode;
	constructor(message: string, code: GoalErrorCode) {
		super(message);
		this.name = "GoalError";
		this.code = code;
	}
}

const BLOCK_CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OBJECTIVE_MAX_LENGTH = 4096;

function resolveObjective(objective: string): string {
	if (typeof objective !== "string" || objective.trim().length === 0) {
		throw new GoalError("objective must be a non-empty string", "GOAL_INVALID_OBJECTIVE");
	}
	const trimmed = objective.trim();
	if (trimmed.length > OBJECTIVE_MAX_LENGTH) {
		throw new GoalError(`objective exceeds ${OBJECTIVE_MAX_LENGTH} characters`, "GOAL_INVALID_OBJECTIVE");
	}
	return trimmed;
}

function resolveMaxGoalRounds(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new GoalError("maxGoalRounds must be a positive safe integer", "GOAL_INVALID_MAX_ROUNDS");
	}
	return value;
}

function resolveBlockReason(reason: GoalBlockReason): GoalBlockReason {
	if (typeof reason !== "object" || typeof reason.code !== "string" || !BLOCK_CODE_RE.test(reason.code)) {
		throw new GoalError(
			`blockedReason.code must match ${BLOCK_CODE_RE}`,
			"GOAL_INVALID_BLOCK_REASON",
		);
	}
	if (typeof reason.message !== "string" || reason.message.trim().length === 0) {
		throw new GoalError("blockedReason.message must be a non-empty string", "GOAL_INVALID_BLOCK_REASON");
	}
	return { code: reason.code, message: reason.message.trim() };
}

/** 每次变更的输入（DSH GoalOperation 动词） */
export type GoalOperation = "create" | "edit" | "pause" | "resume" | "complete" | "block" | "clear";

/** 折叠中间态（DSH GoalFoldState） */
export interface GoalFoldState {
	goal: GoalSnapshot | undefined;
	roundsStarted: number;
	createdAt: number | undefined;
	updatedAt: number | undefined;
	lastRef: GoalRef | undefined;
	seenGoalIds: Set<string>;
}

export function emptyGoalFoldState(): GoalFoldState {
	return {
		goal: undefined,
		roundsStarted: 0,
		createdAt: undefined,
		updatedAt: undefined,
		lastRef: undefined,
		seenGoalIds: new Set(),
	};
}

/**
 * 应用一条 durable 变更到折叠累加器（严格回放校验，照抄 DSH fold）。
 * @throws GoalError 非法/乱序变更
 */
export function applyGoalChange(state: GoalFoldState, change: GoalChange): void {
	if (change.kind !== "goal/change" || change.version !== 1) {
		throw new GoalError("malformed goal change", "GOAL_INVALID_TRANSITION");
	}
	if (change.operation === "clear") {
		if (state.goal === undefined || state.goal.id !== change.cleared.id || state.goal.revision !== change.cleared.revision - 1) {
			throw new GoalError("goal clear does not match the current goal revision", "GOAL_INVALID_TRANSITION");
		}
		state.goal = undefined;
		state.lastRef = change.cleared;
		return;
	}
	// snapshot 变更：create 允许替换已 complete 的目标；其余变更须匹配当前 goal 的连续修订
	const { goal, roundsStarted, createdAt, updatedAt } = change;
	if (change.operation === "create") {
		if (goal.revision !== 1 || goal.phase !== "active" || roundsStarted !== 0) {
			throw new GoalError("goal create requires a fresh active revision-one goal with zero rounds", "GOAL_INVALID_TRANSITION");
		}
		if (state.goal !== undefined && state.goal.phase !== "complete") {
			throw new GoalError("goal create requires the current goal to be complete", "GOAL_INVALID_TRANSITION");
		}
		if (state.seenGoalIds.has(goal.id)) {
			throw new GoalError("goal create reuses a previously seen goal id", "GOAL_INVALID_TRANSITION");
		}
	} else {
		if (state.goal === undefined) {
			throw new GoalError("non-create goal change without a current goal", "GOAL_INVALID_TRANSITION");
		}
		if (goal.id !== state.goal.id) {
			throw new GoalError("goal change id does not match the current goal", "GOAL_INVALID_TRANSITION");
		}
		if (goal.revision !== state.goal.revision + 1) {
			throw new GoalError("goal change revision is not consecutive", "GOAL_INVALID_TRANSITION");
		}
	}
	state.goal = goal;
	state.roundsStarted = roundsStarted;
	state.createdAt = createdAt;
	state.updatedAt = updatedAt;
	state.lastRef = { id: goal.id, revision: goal.revision };
	state.seenGoalIds.add(goal.id);
}

/** 当前折叠出的目标投影（无激活位；DSH FoldedGoal） */
export interface FoldedGoal {
	readonly goal?: GoalSnapshot;
	readonly roundsStarted: number;
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly lastRef?: GoalRef;
}

/** 从有序变更序列折叠当前目标（last-wins，严格校验） */
export function foldGoalChanges(changes: readonly GoalChange[]): FoldedGoal {
	const state = emptyGoalFoldState();
	for (const change of changes) applyGoalChange(state, change);
	return {
		goal: state.goal,
		roundsStarted: state.roundsStarted,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		lastRef: state.lastRef,
	};
}

// ---------------------------------------------------------------------------
// 服务（进程本地 + 由调用方提供持久化钩子）
// ---------------------------------------------------------------------------

export interface GoalDomainConfig {
	/** create 未给上限时的默认轮数（DSH Config.defaultMaxGoalRounds） */
	defaultMaxGoalRounds?: number;
}

/** 一次变更的输入 */
export interface GoalMutationInput {
	operation: GoalOperation;
	ref?: GoalRef;
	objective?: string;
	maxGoalRounds?: number;
	blockedReason?: GoalBlockReason;
}

/** 变更结果：新视图或 tombstone ref */
export type GoalMutationResult =
	| { kind: "view"; view: GoalView }
	| { kind: "tombstone"; ref: GoalRef };

/**
 * 无持久化依赖的 goal 域服务：持有进程本地状态（含激活位），
 * 每次成功变更产出 GoalChange 交给调用方持久化。
 */
export class GoalDomain {
	/** 当前折叠状态（会话内权威，由变更序列重建） */
	private state = emptyGoalFoldState();
	/** 进程本地激活位；绝不持久化 */
	private activation: GoalActivation = "disarmed";
	private readonly config: GoalDomainConfig;

	constructor(config: GoalDomainConfig = {}) {
		this.config = config;
	}

	get view(): GoalView | undefined {
		const { goal, roundsStarted, createdAt, updatedAt } = this.state;
		if (goal === undefined) return undefined;
		return {
			...goal,
			roundsStarted,
			createdAt: createdAt ?? 0,
			updatedAt: updatedAt ?? 0,
			activation: this.activation,
		};
	}

	get ref(): GoalRef | undefined {
		return this.state.lastRef ?? (this.state.goal ? { id: this.state.goal.id, revision: this.state.goal.revision } : undefined);
	}

	/** 从持久化序列重建（session 恢复；round 消息数补 roundsStarted；激活位 disarmed） */
	hydrate(changes: readonly GoalChange[], roundsFromMessages = 0): void {
		this.state = emptyGoalFoldState();
		for (const change of changes) applyGoalChange(this.state, change);
		const goal = this.state.goal;
		if (goal && roundsFromMessages > this.state.roundsStarted) {
			if (roundsFromMessages > goal.maxGoalRounds) {
				throw new GoalError(
					`goal round messages (${roundsFromMessages}) exceed maxGoalRounds (${goal.maxGoalRounds})`,
					"GOAL_INVALID_TRANSITION",
				);
			}
			this.state.roundsStarted = roundsFromMessages;
		}
		this.activation = "disarmed";
	}

	/**
	 * 记录一次已注入的 goal round（驱动器在发送 round 消息后调用）。
	 * 校验：goal 存在且 active、round === roundsStarted+1、不超预算。
	 * 注意：pi 端「排队即消耗」（DSH 为「准入即消耗」——模型轮实际开始时递增），
	 * 差异在于被用户打断的排队轮也会消耗预算。
	 */
	recordGoalRound(details: { goalId: string; revision: number; round: number }): void {
		const goal = this.state.goal;
		if (goal === undefined || goal.phase !== "active") {
			throw new GoalError("goal round requires an active goal", "GOAL_INVALID_TRANSITION");
		}
		if (details.goalId !== goal.id || details.revision !== goal.revision) {
			throw new GoalError(
				`goal round does not match the current goal revision`,
				"GOAL_INVALID_TRANSITION",
			);
		}
		if (details.round !== this.state.roundsStarted + 1 || details.round > goal.maxGoalRounds) {
			throw new GoalError(
				`goal round ${details.round} is not the next admitted round of the active goal (started ${this.state.roundsStarted}, max ${goal.maxGoalRounds})`,
				"GOAL_INVALID_TRANSITION",
			);
		}
		this.state.roundsStarted = details.round;
	}

	/**
	 * 执行一次变更（照抄 DSH GoalService 动词 + CAS + 转换校验）。
	 * @returns 变更记录（调用方负责 appendEntry 持久化）
	 */
	mutate(input: GoalMutationInput): { change: GoalChange; result: GoalMutationResult } {
		const current = this.state.goal;
		const ref = input.ref;

		switch (input.operation) {
			case "create": {
				if (current !== undefined && current.phase !== "complete") {
					throw new GoalError(
						`goal "${current.id}" already exists with phase "${current.phase}"`,
						"GOAL_ALREADY_EXISTS",
					);
				}
				const now = Date.now();
				const goal: GoalSnapshot = {
					id: GoalId(`goal-${randomUUID()}`),
					revision: 1,
					objective: resolveObjective(input.objective ?? ""),
					phase: "active",
					maxGoalRounds: resolveMaxGoalRounds(input.maxGoalRounds ?? this.config.defaultMaxGoalRounds ?? 64),
				};
				const change: GoalChange = {
					kind: "goal/change",
					version: 1,
					operation: "create",
					goal,
					roundsStarted: 0,
					createdAt: now,
					updatedAt: now,
				};
				this.apply(change);
				this.activation = "armed";
				return { change, result: { kind: "view", view: this.view! } };
			}
			case "edit": {
				const cur = this.expectCurrent(ref);
				if (input.objective === undefined && input.maxGoalRounds === undefined) {
					throw new GoalError("goal edit requires objective and/or maxGoalRounds", "GOAL_INVALID_EDIT");
				}
				const goal: GoalSnapshot = {
					...cur,
					revision: cur.revision + 1,
					...input.objective === undefined ? {} : { objective: resolveObjective(input.objective) },
					...input.maxGoalRounds === undefined ? {} : { maxGoalRounds: resolveMaxGoalRounds(input.maxGoalRounds) },
				};
				return this.commitSnapshot("edit", goal);
			}
			case "pause":
				return this.transition(input.ref, "pause", ["active"], "paused");
			case "resume": {
				const cur = this.expectCurrent(ref);
				const resumable: GoalPhase[] = ["active", "paused", "blocked"];
				if (!resumable.includes(cur.phase)) throw this.transitionError(cur, "resume", resumable);
				if (cur.phase === "active" && this.activation === "armed") {
					throw new GoalError(`goal "${cur.id}" is already active and armed`, "GOAL_INVALID_TRANSITION");
				}
				if (this.state.roundsStarted >= cur.maxGoalRounds) {
					throw new GoalError(
						`goal "${cur.id}" exhausted ${cur.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
						"GOAL_INVALID_TRANSITION",
					);
				}
				const result = this.commitSnapshot("resume", { ...cur, revision: cur.revision + 1, phase: "active" });
				this.activation = "armed";
				return { change: result.change, result: { kind: "view", view: this.view! } };
			}
			case "complete":
				return this.transition(input.ref, "complete", ["active", "paused", "blocked"], "complete");
			case "block": {
				const cur = this.expectCurrent(ref);
				if (cur.phase !== "active") throw this.transitionError(cur, "block", ["active"]);
				const result = this.commitSnapshot("block", {
					...cur,
					revision: cur.revision + 1,
					phase: "blocked",
					blockedReason: resolveBlockReason(input.blockedReason ?? { code: "", message: "" }),
				});
				this.activation = "disarmed";
				return { change: result.change, result: { kind: "view", view: this.view! } };
			}
			case "clear": {
				const cur = this.expectCurrent(ref);
				const tombstone: GoalRef = { id: cur.id, revision: cur.revision + 1 };
				const change: GoalChange = {
					kind: "goal/change",
					version: 1,
					operation: "clear",
					cleared: tombstone,
					clearedAt: Date.now(),
				};
				this.apply(change);
				this.activation = "disarmed";
				return { change, result: { kind: "tombstone", ref: tombstone } };
			}
		}
	}

	/** 解除进程本地续行资格（不改变 durable phase/revision；DSH disarm） */
	disarm(): void {
		this.activation = "disarmed";
	}

	private expectCurrent(ref: GoalRef | undefined): GoalSnapshot {
		const current = this.state.goal;
		if (current === undefined) throw new GoalError("no current goal", "GOAL_NOT_FOUND");
		if (ref === undefined || ref.id !== current.id || ref.revision !== current.revision) {
			throw new GoalError(
				`stale goal ref "${ref?.id}" revision ${ref?.revision}; current is "${current.id}" revision ${current.revision}`,
				"GOAL_STALE_REVISION",
			);
		}
		return current;
	}

	private transition(ref: GoalRef | undefined, operation: Exclude<GoalOperation, "clear">, from: GoalPhase[], to: GoalPhase): { change: GoalChange; result: GoalMutationResult } {
		const cur = this.expectCurrent(ref);
		if (!from.includes(cur.phase)) throw this.transitionError(cur, operation, from);
		const result = this.commitSnapshot(operation, { ...cur, revision: cur.revision + 1, phase: to });
		this.activation = "disarmed";
		return { change: result.change, result: { kind: "view", view: this.view! } };
	}

	private transitionError(cur: GoalSnapshot, operation: string, allowed: GoalPhase[]): GoalError {
		return new GoalError(
			`goal ${operation} has an invalid phase transition from "${cur.phase}" (allowed: ${allowed.join(", ")})`,
			"GOAL_INVALID_TRANSITION",
		);
	}

	private commitSnapshot(operation: "create" | "edit" | "pause" | "resume" | "complete" | "block", goal: GoalSnapshot): { change: GoalChange; result: GoalMutationResult } {
		const now = Date.now();
		const change: GoalChange = {
			kind: "goal/change",
			version: 1,
			operation,
			goal,
			roundsStarted: this.state.roundsStarted,
			createdAt: this.state.createdAt ?? now,
			updatedAt: now,
		};
		this.apply(change);
		return { change, result: { kind: "view", view: this.view! } };
	}

	private apply(change: GoalChange): void {
		applyGoalChange(this.state, change);
	}
}
