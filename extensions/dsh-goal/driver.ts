// driver.ts — DSH dsh-goal-round-driver 移植：agent_settled 续行驱动器
//
// 语义照抄 @deepseek-ai/dsh-goal-round-driver：
//   - 检查点：agent 停歇（pi agent_settled）→ goal active + armed + 预算未耗尽
//   - 注入 <goal_round> 用户消息（含 objective JSON + round/max，照抄 DSH 格式）
//   - 预算耗尽 → 驱动器自动 block（code: "limit-reached"）
//   - round 消息带 customType dsh-goal-round + details{goalId, revision, round}，
//     供 tools.ts 的权限校验（complete/blocked 的 goal-round 权威）与折叠恢复
//   - 差异（文档化）：DSH「准入即消耗」预算，pi 端「排队即消耗」（sendMessage 后立即
//     recordGoalRound）——被用户打断的排队轮也会消耗预算

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalDomain, type GoalChange } from "./state.ts";
import { GOAL_ROUND_CUSTOM_TYPE, type GoalRoundDetails } from "./tools.ts";

/** round 提示词（照抄 DSH goal-round-driver 的 <goal_round> 模板） */
export function buildGoalRoundPrompt(objective: string, round: number, maxGoalRounds: number): string {
	return `<goal_round>
Objective: ${JSON.stringify(objective)}\nRound: ${round}/${maxGoalRounds}\n\nContinue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.
</goal_round>`;
}

export interface GoalDriverOptions {
	/** 持久化钩子（appendEntry "dsh-goal-change"） */
	persist: (change: GoalChange) => void;
}

/** 注册续行驱动器（agent_settled 检查点） */
export function registerGoalDriver(pi: ExtensionAPI, domain: GoalDomain, options: GoalDriverOptions): void {
	const { persist } = options;

	pi.on("agent_settled", () => {
		const view = domain.view;
		if (!view) return;
		if (view.phase !== "active" || view.activation !== "armed") return;

		// 预算耗尽：驱动器自动 block（DSH checkGoalRounds 的 limit-reached 分支）
		if (view.roundsStarted >= view.maxGoalRounds) {
			const blocked = domain.mutate({
				operation: "block",
				ref: { id: view.id, revision: view.revision },
				blockedReason: {
					code: "limit-reached",
					message: `Goal reached its configured limit of ${view.maxGoalRounds} rounds.`,
				},
			});
			persist(blocked.change);
			return;
		}

		// 注入下一轮
		const round = view.roundsStarted + 1;
		const details: GoalRoundDetails = { goalId: view.id, revision: view.revision, round };
		domain.recordGoalRound(details);
		const prompt = buildGoalRoundPrompt(view.objective, round, view.maxGoalRounds);
		pi.sendMessage(
			{
				customType: GOAL_ROUND_CUSTOM_TYPE,
				content: prompt,
				display: false,
				details,
			},
			{ triggerTurn: true },
		);
	});
}
