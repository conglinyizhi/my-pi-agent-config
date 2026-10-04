// lib/worker-ptc-approval.ts — worker 进程里的 run_code 审批
//
// worker 没有窗口，也没有人工闸门，所以审批只有两条出路：
//   1. 预审判 safe 且档位 auto → 直接执行（与主 agent 同一条链、同一处判据）
//   2. 判不出安全 → 写 capability 请求，在工具调用内阻塞等父进程的答复
//
// 脚本内层调用的边界不在这一层管：它们各自过 worker 自己的守门（bash 与路径表）。
// 这里只回答「这段脚本值不值得惊动人」。

import { unlinkSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	preReviewPtcScript,
	type PtcAuditDependencies,
	type PtcAuditInput,
	type PtcAuditOutcome,
} from "./ptc-audit.ts";
import {
	makeCapabilityRequest,
	readCapabilityDecisionFile,
	waitForCapabilityDecision,
	writeCapabilityRequestFile,
} from "./subagent-capability.ts";

/** 继承主链的依赖面，好让 registerRunCode 的 approve 接点直接换成本函数 */
export interface WorkerPtcApprovalDeps extends PtcAuditDependencies {
	/** 测试注入；默认走真实预审（与主 agent 同一处判据） */
	preReview?: typeof preReviewPtcScript;
	/** 测试注入；默认读 worker 进程的审批通道环境变量 */
	requestPath?: string;
	responsePath?: string;
	taskId?: string;
	parentAlive?: () => boolean;
}

export async function approvePtcScriptInWorker(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	input: PtcAuditInput;
	signal?: AbortSignal;
	deps?: WorkerPtcApprovalDeps;
}): Promise<PtcAuditOutcome> {
	const { pi, ctx, input, signal } = options;
	const deps = options.deps ?? {};

	const pre = await (deps.preReview ?? preReviewPtcScript)({ pi, ctx, input, signal });
	if (pre.autoApproved) return { approved: true, review: pre.review };

	const requestPath = deps.requestPath ?? process.env.PI_SUBAGENT_CAPABILITY_REQUEST;
	const responsePath = deps.responsePath ?? process.env.PI_SUBAGENT_CAPABILITY_RESPONSE;
	if (!requestPath || !responsePath) {
		return { approved: false, review: pre.review, comment: "worker 缺少审批响应通道，脚本未执行。" };
	}

	const request = makeCapabilityRequest({
		capability: "command",
		command: input.script,
		reason: pre.review?.reason ?? input.reason ?? "worker 里的脚本需要主 agent 审批。",
		cwd: ctx.cwd,
		taskId: deps.taskId ?? process.env.PI_TASK_ID,
		scope: "worker 脚本（run_code）",
	});
	if (!writeCapabilityRequestFile(requestPath, request)) {
		return { approved: false, review: pre.review, comment: "权限请求写入失败，脚本未执行。" };
	}

	const decision = await waitForCapabilityDecision(request.requestId, {
		readDecision: () => readCapabilityDecisionFile(responsePath),
		parentAlive: deps.parentAlive ?? (() => process.ppid !== 1),
	});
	try {
		unlinkSync(responsePath);
	} catch {
		// 父进程可能已经清理过
	}

	if (decision.action !== "allow") {
		return { approved: false, review: pre.review, comment: decision.comment || "未获批准" };
	}
	return {
		approved: true,
		review: pre.review,
		...(decision.comment ? { comment: decision.comment } : {}),
	};
}
