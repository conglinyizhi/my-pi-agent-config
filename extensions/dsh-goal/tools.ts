// tools.ts — DSH dsh-tool-goal 移植：get_goal / create_goal / update_goal
//
// 语义照抄 @deepseek-ai/dsh-tool-goal：
//   - create/edit/pause/resume 需要「直接人类轮次」（DSH requireDirectHuman）：
//     最后一条 user 角色消息必须是人类（pi 中 role==="user"），而非 goal round 消息
//     （role==="custom" 且 customType==="dsh-goal-round"）
//   - complete/blocked 允许「直接人类轮次」或「恰好匹配当前 goal round」
//   - blocked 在连续轮次低于阈值（blockedAfterConsecutiveRounds，默认 3）时被拒
//   - subagent 子进程（PI_SUBAGENT=1）内不注册工具（DSH「subagent 执行一律被拒」）

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerSection } from "../../lib/prompt-sections.ts";
import { GoalDomain, GoalError, type GoalRef, type GoalView } from "./state.ts";

export const GOAL_ROUND_CUSTOM_TYPE = "dsh-goal-round";

/** goal round 消息 details：折叠与准入校验用 */
export interface GoalRoundDetails {
	goalId: string;
	revision: number;
	round: number;
}

type MessageEntry = SessionEntry & {
	type: "message";
	message: {
		role: string;
		customType?: string;
		details?: unknown;
	};
}

/** 从会话 entries 判断「当前轮次」来源（从后往前第一条 user/custom 消息） */
export function lastUserTurnKind(entries: SessionEntry[]): "human" | "goal-round" | "none" {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = (entry as MessageEntry).message;
		if (message.role === "user") return "human";
		if (message.role === "custom" && message.customType === GOAL_ROUND_CUSTOM_TYPE) return "goal-round";
		// 其他 custom（plan-mode 等）不是轮次来源，继续往前找
	}
	return "none";
}

/** 当前轮次是否为匹配当前 goal 的 round（DSH completionAuthority 的 goal-round 分支） */
export function isCurrentGoalRound(entries: SessionEntry[], domain: GoalDomain): boolean {
	const view = domain.view;
	if (!view) return false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = (entry as MessageEntry).message;
		if (message.role !== "custom" || message.customType !== GOAL_ROUND_CUSTOM_TYPE) continue;
		const details = message.details as GoalRoundDetails | undefined;
		if (!details) continue;
		return (
			details.goalId === view.id &&
			details.revision === view.revision &&
			details.round === view.roundsStarted
		);
	}
	return false;
}

function requireDirectHuman(entries: SessionEntry[]): void {
	if (lastUserTurnKind(entries) !== "human") {
		throw new GoalError("this goal operation requires a direct human turn on a top-level agent", "GOAL_INVALID_TRANSITION");
	}
}

function goalValue(view: GoalView | undefined) {
	return {
		goal: view
			? {
					id: view.id,
					revision: view.revision,
					objective: view.objective,
					phase: view.phase,
					maxGoalRounds: view.maxGoalRounds,
					roundsStarted: view.roundsStarted,
					createdAt: view.createdAt,
					updatedAt: view.updatedAt,
					activation: view.activation,
					...view.blockedReason === undefined ? {} : { blockedReason: view.blockedReason },
				}
			: null,
	};
}

/** 模型可见的 goal 状态文本（get_goal 的 content 用；details 不入模型上下文，必须放 content） */
function goalText(view: GoalView | undefined): string {
	if (!view) return "（无当前目标）";
	const header = `goal ${view.id.slice(0, 12)}… rev=${view.revision} | phase=${view.phase} | rounds=${view.roundsStarted}/${view.maxGoalRounds} | ${view.activation === "armed" ? "armed" : "disarmed"}`;
	const blocked = view.blockedReason ? `\nblocked: ${view.blockedReason.code} — ${view.blockedReason.message}` : "";
	return `${header}\nobjective: ${view.objective}${blocked}`;
}

const UPDATE_ACTIONS = ["edit", "pause", "resume", "complete", "blocked"] as const;

const GOAL_ID_PARAMETER = Type.String({ description: "Exact id returned by get_goal." });
const REVISION_PARAMETER = Type.Number({ description: "Exact positive revision returned by get_goal." });

/**
 * 按 action 收窄参数形状，避免 complete/resume 等操作看起来可以携带 edit 字段。
 * 每个分支都重复公共字段，是为了让 JSON Schema 给模型展示清晰的合法组合。
 */
export const UPDATE_PARAMETERS = Type.Union([
	Type.Object({
		goal_id: GOAL_ID_PARAMETER,
		revision: REVISION_PARAMETER,
		action: Type.Literal("edit"),
		objective: Type.Optional(Type.String({ description: "Replacement objective for this goal." })),
		max_goal_rounds: Type.Optional(Type.Number({ description: "Replacement positive safe-integer cap for automatic continuation rounds." })),
	}, { additionalProperties: false }),
	Type.Object({
		goal_id: GOAL_ID_PARAMETER,
		revision: REVISION_PARAMETER,
		action: Type.Literal("pause"),
	}, { additionalProperties: false }),
	Type.Object({
		goal_id: GOAL_ID_PARAMETER,
		revision: REVISION_PARAMETER,
		action: Type.Literal("resume"),
	}, { additionalProperties: false }),
	Type.Object({
		goal_id: GOAL_ID_PARAMETER,
		revision: REVISION_PARAMETER,
		action: Type.Literal("complete"),
	}, { additionalProperties: false }),
	Type.Object({
		goal_id: GOAL_ID_PARAMETER,
		revision: REVISION_PARAMETER,
		action: Type.Literal("blocked"),
		blocked_reason: Type.String({ description: "Concrete blocking condition that has persisted across the required goal rounds." }),
	}, { additionalProperties: false }),
]);

function goalRef(id: string, revision: number): GoalRef {
	return { id: id as GoalRef["id"], revision };
}

export interface GoalToolsOptions {
	/** blocked 阈值：goal-round 轮次里 blocked 至少需要的连续轮数 */
	blockedAfterConsecutiveRounds?: number;
}

const GET_DESCRIPTION =
	"Read the current same-session goal, or null. Call it before update_goal and copy its exact goal_id and revision. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it.";

const CREATE_DESCRIPTION =
	'Create one persisted same-session completion goal when the current direct human request is a long-running objective that should continue across autonomous goal rounds. You may infer that intent without requiring the user to say "create a goal". Do not use this for trivial single-turn work. Execution rejects non-human and subagent authority.';

/** 注册三个 goal 工具 + 提示词指导段 */
export function registerGoalTools(pi: ExtensionAPI, domain: GoalDomain, options: GoalToolsOptions = {}): void {
	const blockedAfter = options.blockedAfterConsecutiveRounds ?? 3;

	// 提示词指导段（order 114，track A 的 prompt-sections 装配）
	registerSection({
		name: "tool:goal",
		order: 114,
		text: () =>
			`Use goal tools for one long-running completion objective in the current session. create_goal may infer goal intent from a direct human request in any language; do not create a goal for routine single-turn work. A goal is the cross-round long-term objective (one per session, human-sanctioned, drives auto-continuation); break down the current task into concrete steps with todo_write instead. Call get_goal before update_goal and copy its exact goal_id and revision. Action fields are exclusive: edit may include objective and max_goal_rounds; pause, resume, and complete take only action, goal_id, and revision; blocked additionally requires blocked_reason. Never send empty, copied, or irrelevant optional fields. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved, using only { action: "complete", goal_id, revision }. Mark blocked only after the same blocking condition persists for at least ${blockedAfter} consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.`,
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: GET_DESCRIPTION,
		promptSnippet: "Read the current same-session goal",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: goalText(domain.view) }], details: goalValue(domain.view) };
		},
	});

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description: CREATE_DESCRIPTION,
		promptSnippet: "Create one persisted same-session completion goal for a long-running objective",
		parameters: Type.Object({
			objective: Type.String({
				description: "The concrete completion objective inferred from the direct human request.",
			}),
			max_goal_rounds: Type.Optional(
				Type.Number({ description: "Optional positive safe-integer limit on automatic continuation rounds." }),
			),
		}),
		async execute(_toolCallId, params: { objective: string; max_goal_rounds?: number }, _signal, _onUpdate, ctx) {
			requireDirectHuman(ctx.sessionManager.getEntries());
			const created = domain.mutate({
				operation: "create",
				objective: params.objective,
				maxGoalRounds: params.max_goal_rounds,
			});
			pi.appendEntry("dsh-goal-change", created.change);
			const createdView = created.result.kind === "view" ? created.result.view : undefined;
			return {
				content: [{ type: "text", text: `Created goal\n${goalText(createdView)}` }],
				details: goalValue(createdView),
			};
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Update the exact current goal revision. Action fields are exclusive: edit may include objective and max_goal_rounds; pause, resume, and complete accept only action, goal_id, and revision; blocked additionally requires blocked_reason. Never send unused optional fields. edit, pause, and resume require a direct top-level human request. During an automatic continuation of the current goal, complete and blocked are also allowed. blocked is rejected before the configured minimum round count.",
		promptSnippet: "Update a goal with only the fields valid for its action",
		parameters: UPDATE_PARAMETERS,
		async execute(
			_toolCallId,
			params: {
				goal_id: string;
				revision: number;
				action: (typeof UPDATE_ACTIONS)[number];
				objective?: string;
				max_goal_rounds?: number;
				blocked_reason?: string;
			},
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			const entries = ctx.sessionManager.getEntries();
			const ref = goalRef(params.goal_id, params.revision);
			const hasObjective = typeof params.objective === "string" && params.objective.trim().length > 0;
			const hasRoundCap = params.max_goal_rounds !== undefined;
			const hasBlockedReason = typeof params.blocked_reason === "string" && params.blocked_reason.trim().length > 0;

			if (params.action === "edit") {
				requireDirectHuman(entries);
				if (hasBlockedReason) throw new GoalError("blocked_reason is valid only with action blocked", "GOAL_INVALID_EDIT");
				const edited = domain.mutate({
					operation: "edit",
					ref,
					objective: hasObjective ? params.objective : undefined,
					maxGoalRounds: hasRoundCap ? params.max_goal_rounds : undefined,
				});
				pi.appendEntry("dsh-goal-change", edited.change);
				const editedView = edited.result.kind === "view" ? edited.result.view : undefined;
				return {
					content: [{ type: "text", text: `Edited goal\n${goalText(editedView)}` }],
					details: goalValue(editedView),
				};
			}

			if (params.action === "pause" || params.action === "resume") {
				requireDirectHuman(entries);
				if (hasObjective || hasRoundCap || hasBlockedReason) {
					throw new GoalError(
						"objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked",
						"GOAL_INVALID_EDIT",
					);
				}
				const changed = domain.mutate({ operation: params.action, ref });
				pi.appendEntry("dsh-goal-change", changed.change);
				const changedView = changed.result.kind === "view" ? changed.result.view : undefined;
				return {
					content: [{ type: "text", text: `${params.action === "pause" ? "Paused" : "Resumed"} goal\n${goalText(changedView)}` }],
					details: goalValue(changedView),
				};
			}

			// complete / blocked：需要直接人类或恰好当前 goal round
			const directHuman = lastUserTurnKind(entries) === "human";
			const currentRound = isCurrentGoalRound(entries, domain);
			if (!directHuman && !currentRound) {
				throw new GoalError(
					"complete and blocked require a direct human turn or the current goal round",
					"GOAL_INVALID_TRANSITION",
				);
			}
			if (hasObjective || hasRoundCap) {
				throw new GoalError("objective and max_goal_rounds are valid only with action edit", "GOAL_INVALID_EDIT");
			}
			if (params.action === "complete" && hasBlockedReason) {
				throw new GoalError("blocked_reason is valid only with action blocked", "GOAL_INVALID_EDIT");
			}
			if (params.action === "blocked") {
				if (!hasBlockedReason) {
					throw new GoalError("blocked_reason is required with action blocked", "GOAL_INVALID_EDIT");
				}
				const view = domain.view;
				if (!currentRound && view && view.roundsStarted < blockedAfter) {
					throw new GoalError(
						`blocked requires at least ${blockedAfter} consecutive goal rounds; current round is ${view.roundsStarted}`,
						"GOAL_INVALID_TRANSITION",
					);
				}
			}
			const completed = domain.mutate({
				operation: params.action === "complete" ? "complete" : "block",
				ref,
				blockedReason: hasBlockedReason ? { code: "model-reported", message: params.blocked_reason!.trim() } : undefined,
			});
			pi.appendEntry("dsh-goal-change", completed.change);
			const completedView = completed.result.kind === "view" ? completed.result.view : undefined;
			return {
				content: [{ type: "text", text: `${params.action === "complete" ? "Completed goal" : "Marked goal blocked"}\n${goalText(completedView)}` }],
				details: goalValue(completedView),
			};
		},
	});
}
