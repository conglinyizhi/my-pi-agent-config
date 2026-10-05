// lib/review-flow/types.ts — 审核流的类型层（纯类型，不碰 IO）
//
// 设计稿：docs/plans/2026-10-05-review-flow-sdk.md
// 三层边界：节点库（SDK）/ 流程运行器 / 流程的表示（v1 = TS 模块）。
// 这里只放三层的公共形状：节点声明、流程声明、轨迹记录、决定。

/** 节点种类：全部是既有能力的搬运，每一条都已存在且有测试 */
export type NodeKind =
	| "facts"
	| "rule"
	| "scan"
	| "dryrun"
	| "classifier"
	| "chatreview"
	| "merge"
	| "gate"
	| "autoapprove"
	| "terminal"
	/** 作者自己的节点：实现随流程文件一起交（见 lib/review-flow/kit.ts） */
	| "custom";

/**
 * 节点级执行语义：
 *   serial    等上游结论再决定跑不跑（省调用，慢在关键路径）
 *   parallel  与同组节点同时开跑（快，调用多）
 *   cascade   按 settings.order 逐个跑，判出结论就停（便宜的先跑）
 */
export type NodeMode = "serial" | "parallel" | "cascade";

/** 流程的出口。默认 fail = 拒绝（硬约束 3）：要放行必须在图上显式写 allow */
export type Terminal = "allow" | "deny";

/**
 * 一个节点。两件事分开写：
 *
 *   数据流 after   我要用哪些节点的产物（拿得到就传进 ctx.upstream）
 *   控制流 边      next / onError / onTimeout / onEmpty：往哪走
 *
 * 分开的理由：顺序不该由"谁依赖谁"推出来。自动放行的节点判不出来时才轮到人工闸门，
 * 这一条是控制流，写成依赖会让闸门提前跑起来。
 */
export interface FlowNode {
	id: string;
	kind: NodeKind;
	/** 输入依赖：这些节点都跑过之后，它们的产物进 ctx.upstream */
	after?: string[];
	/** 成功之后去哪（节点 id，或 allow / deny）；不接就看它有没有下游 */
	next?: string;
	/**
	 * 按脚本返回值选边：出口名 → 目标（节点 id，或 allow / deny）。
	 *
	 *   bool 二选一：脚本返回 branch: "yes" / "no"
	 *   枚举多路：脚本返回 branch: "upload" / "fetch-only" / "none"
	 *
	 * 没声明的出口是 fail-closed：记一条失败轨迹，走流程的 fail 出口，不猜。
	 */
	branches?: Record<string, string>;
	mode?: NodeMode;
	/** 节点自己的参数（超时、阈值、合并策略……）：是数据，不是代码里的 if */
	settings?: Record<string, unknown>;
	/** 出错走哪条边（节点 id，或 allow / deny）；不接就走流程的 fail 出口 */
	onError?: string;
	/** 超时走哪条边；不接就退到 onError */
	onTimeout?: string;
	/** 拿不到结论（弃权）走哪条边；不接就退到 onError */
	onEmpty?: string;
}

export interface Flow {
	id: string;
	/** 整次运行的硬上限：超了就是这次审计失败，走 fail 出口 */
	deadlineMs?: number;
	budget?: {
		/** 模型调用次数上限（费用上限 v1 先不接） */
		calls?: number;
		cost?: number;
	};
	nodes: FlowNode[];
	/** 流程的 fail 出口：默认拒绝 */
	onError?: Terminal;
}

/** 一条节点轨迹。窗口要回答的两个问题：卡在哪、为什么是这个结论 */
export interface TraceRecord {
	nodeId: string;
	kind: NodeKind;
	startedAt: number;
	endedAt: number;
	/** 结论词（判了什么、跳过了、失败了……）；给窗口做高亮用 */
	status: "ran" | "skipped" | "failed" | "timedout" | "budget";
	/** 走到这个节点的原因（哪条边进来的） */
	via?: string;
	/** 从哪条边出去 */
	to?: string;
	/** 走了哪个分支出口（脚本返回的那个值） */
	branch?: string;
	/** 一句话结论与它的理由原文 */
	verdict?: string;
	reason?: string;
	/** 输入 / 输出摘要（送审了什么、多长、哪些维度不适用） */
	inputSummary?: string;
	outputSummary?: string;
	/** 模型、耗时、调用次数、是否命中缓存 */
	model?: string;
	calls?: number;
	cached?: boolean;
}
