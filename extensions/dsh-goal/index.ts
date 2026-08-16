// dsh-goal — DSH dsh-goal 移植：事件溯源持久化目标 + 自动续行（Track B 第二批）
//
// 见 docs/plans/2026-08-15-dsh-architecture-migration.md §7 #3：
//   - state.ts    纯状态机 + CAS + 转换校验 + 折叠（无 pi 依赖）
//   - tools.ts    get_goal / create_goal / update_goal（人类权限 + goal-round 权威）
//   - driver.ts   agent_settled 续行驱动器（<goal_round> 注入 + 预算 block）
//
// 持久化：每次变更 appendEntry("dsh-goal-change", change)（等价 DSH goal/change 事件）；
//   session_start 从会话 entries 折叠变化序列 + round 消息数重建（last-wins）。
//   激活位（armed/disarmed）进程本地，绝不持久化——resume/fork 后须人类显式 resume 重新武装。
//
// 开关（settings.json，/reload 生效）：
//   "dshGoal": true — 注册 goal 工具/驱动器/命令。默认 false：
//     与现有 /goal 扩展（extensions/goal，v0.1.0 的 <summary> 续行）A/B 共存——
//     同一会话同时激活两个续行循环会打架，启用 dsh-goal 前建议停用 /goal。
//
// /dsh-goal 命令：status | <objective> | edit <objective|max:N> | pause | resume | complete | clear

import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GoalDomain, type GoalChange } from "./state.ts";
import { registerGoalTools } from "./tools.ts";
import { registerGoalDriver } from "./driver.ts";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function readSettings(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

type ChangeEntry = SessionEntry & {
	type: "custom";
	customType: "dsh-goal-change";
	data?: GoalChange;
};

type RoundMessageEntry = SessionEntry & {
	type: "message";
	message: { role: string; customType?: string; details?: { goalId?: string } };
}

/** 折叠会话 entries 里的 durable 变更序列（按序，last-wins） */
export function foldChangesFromEntries(entries: SessionEntry[]): GoalChange[] {
	const changes: GoalChange[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		const custom = entry as ChangeEntry;
		if (custom.customType === "dsh-goal-change" && custom.data && custom.data.kind === "goal/change") {
			changes.push(custom.data);
		}
	}
	return changes;
}

/** 折叠 round 消息数（goalId 匹配；驱动器的「排队即消耗」记录） */
export function countRoundMessages(entries: SessionEntry[], goalId: string): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = (entry as RoundMessageEntry).message;
		if (message.role === "custom" && message.customType === "dsh-goal-round" && message.details?.goalId === goalId) {
			count += 1;
		}
	}
	return count;
}

export default function (pi: ExtensionAPI) {
	// 子进程（subagent worker）不加载 goal 工具/驱动器（DSH「subagent 执行一律被拒」的进程级实现）
	if (process.env.PI_SUBAGENT) return;

	const settings = readSettings();
	if (settings.dshGoal !== true) return; // 默认关闭（与现有 /goal A/B 共存，避免双续行循环）

	const domain = new GoalDomain({ defaultMaxGoalRounds: 64 });
	const persist = (change: GoalChange): void => {
		pi.appendEntry("dsh-goal-change", change);
	};

	// session_start / resume / fork：从会话日志重建（激活位 disarmed，须显式 resume）
	pi.on("session_start", (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const changes = foldChangesFromEntries(entries);
		const last = changes[changes.length - 1];
		const currentId = last && "goal" in last ? last.goal.id : undefined;
		const rounds = currentId ? countRoundMessages(entries, currentId) : 0;
		try {
			domain.hydrate(changes, rounds);
		} catch (err) {
			ctx.ui.notify(`[dsh-goal] 会话 goal 恢复失败，已重置: ${err instanceof Error ? err.message : String(err)}`, "warning");
			domain.hydrate([], 0);
		}
	});

	registerGoalTools(pi, domain, { blockedAfterConsecutiveRounds: 3 });
	registerGoalDriver(pi, domain, { persist });

	// /dsh-goal 命令
	pi.registerCommand("dsh-goal", {
		description: "持久化目标管理：status | <objective> | edit <objective|max:N> | pause | resume | complete | clear",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const line = (args ?? "").trim();
			const view = domain.view;

			const render = (v: typeof view) =>
				v
					? `goal ${v.id.slice(0, 12)}… rev=${v.revision} [${v.phase}] rounds=${v.roundsStarted}/${v.maxGoalRounds} ${v.activation === "armed" ? "armed" : "disarmed"}\n${v.objective}${v.blockedReason ? `\nblocked: ${v.blockedReason.code} — ${v.blockedReason.message}` : ""}`
					: "（无当前目标）";

			if (!line || line === "status") {
				ctx.ui.notify(`dsh-goal: ${render(view)}`, "info");
				return;
			}

			const [verb, ...rest] = line.split(/\s+/);
			try {
				if (verb === "edit") {
					const arg = rest.join(" ");
					const maxMatch = /^max:(\d+)$/.exec(arg);
					const changed = domain.mutate({
						operation: "edit",
						ref: domain.ref,
						objective: maxMatch || !arg ? undefined : arg,
						maxGoalRounds: maxMatch ? Number(maxMatch[1]) : undefined,
					});
					persist(changed.change);
					ctx.ui.notify(`dsh-goal: 已编辑 → ${render(domain.view)}`, "info");
				} else if (verb === "pause" || verb === "resume" || verb === "complete") {
					const changed = domain.mutate({ operation: verb, ref: domain.ref });
					persist(changed.change);
					ctx.ui.notify(`dsh-goal: 已 ${verb} → ${render(domain.view)}`, "info");
				} else if (verb === "clear") {
					const changed = domain.mutate({ operation: "clear", ref: domain.ref });
					persist(changed.change);
					ctx.ui.notify("dsh-goal: 已清除（tombstone 已持久化）", "info");
				} else {
					// 默认：create
					const objective = line;
					const created = domain.mutate({ operation: "create", objective });
					persist(created.change);
					ctx.ui.notify(`dsh-goal: 已创建并武装 → ${render(domain.view)}`, "info");
				}
			} catch (err) {
				ctx.ui.notify(`dsh-goal: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
