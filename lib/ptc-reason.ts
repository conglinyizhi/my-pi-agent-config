// lib/ptc-reason.ts — PTC 工具（run_code）的执行理由：消毒、登记、回查
//
// 为什么要有这一层：run_code 的脚本里派发的调用（bash / edit / …）只带自己的参数，
// 而「这段程序要干什么」写在 run_code 自己的 description 上。受审的偏偏是内层调用，
// 理由跨不过去，审核侧看到的就永远是一条没有来由的命令。
//
// 跨过去靠 pi 原生的 id 链：内层调用的 toolCallId 是 `<run_code 的 id>/<n>`，
// tool_call 事件里另带 parentToolCallId。所以登记表按 callId 存，回查时先看调用
// 自己的（它就是 run_code），再顺着 parentToolCallId 找父调用。
//
// 理由和别的参数一样是不可信文本：写代码的那只手也写理由，能从文件里注入进来的
// 东西同样能从理由里进来。所以入库前先消毒（见 sanitizeExecutionReason），
// 审核侧拿到的一定是单行、无尖括号、有长度上限的一段文本。

import { createHash } from "node:crypto";
import { processSingleton } from "./process-singleton.ts";

/** 带执行理由的工具名。审核侧按它认「这是父调用」 */
export const PTC_TOOL_NAME = "run_code";

/** 理由保留的最长字符数。一句话，不是一篇文档 */
export const REASON_MAX_CHARS = 200;

/** 登记表上限：内层调用始终没来的那次，不能永远占着位置 */
const LEDGER_LIMIT = 64;

/** 会把提示词行结构搞坏的控制字符 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** 所有空白（含换行）压成一个空格 */
const WHITESPACE_RUN = /\s+/g;

/** 尖括号换全角：理由不能自己闭合、也不能另开一段信封标签 */
const ANGLE = /[<>]/g;

/**
 * 把理由洗成能放进提示词信封的一段文本。
 *
 * 三条性质各自挡一种「不再是数据」的路：
 * - 单行：换行与控制字符压平，伪造不了周围提示词的行结构
 * - 无标签语法：尖括号换全角，闭合不了 <execution_reason> 再另开一段
 * - 有界：理由是一句话，无界字段就是给注入留的空间
 *
 * @param raw 候选文本，直接来自工具参数
 * @returns 洗过的理由；不是非空字符串时返回 undefined
 */
export function sanitizeExecutionReason(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const flattened = raw.replace(CONTROL_CHARS, " ").replace(WHITESPACE_RUN, " ").trim();
	if (flattened.length === 0) return undefined;
	const neutralized = flattened.replace(ANGLE, (character) => (character === "<" ? "＜" : "＞"));
	return neutralized.length > REASON_MAX_CHARS
		? `${neutralized.slice(0, REASON_MAX_CHARS - 1)}…`
		: neutralized;
}

/** 一次调用的身份：自己是谁、父调用是谁（pi 给内层调用补 parentToolCallId） */
export interface PtcCallRef {
	callId?: string;
	parentToolCallId?: string;
}

/** 登记表里的一条：哪次调用、当时说了什么 */
export interface PtcReasonEntry {
	callId: string;
	reason: string;
}

export interface PtcReasonLedger {
	/** 记下 run_code 这次调用的理由；返回洗过的理由，空理由返回 undefined 且不记 */
	record(callId: string | undefined, raw: unknown): string | undefined;
	/** 按调用 id 取理由（只取它自己声明过的） */
	recall(callId: string | undefined): string | undefined;
	/** 取这次调用适用的理由：自己的，否则它所属的那次 run_code 的 */
	recallForCall(ref: PtcCallRef): string | undefined;
	/** 最近的若干条（新在前），给排障与审核侧巡检用 */
	recent(limit?: number): PtcReasonEntry[];
	readonly size: number;
	/** 清空内容而不是换引用：这是跨扩展共享的那一份 */
	clear(): void;
}

/** 建一份登记表。上限之外的最早一条先走（Map 的插入序） */
export function createPtcReasonLedger(limit: number = LEDGER_LIMIT): PtcReasonLedger {
	const seen = new Map<string, string>();
	const trim = () => {
		while (seen.size > limit) {
			const oldest = seen.keys().next();
			if (oldest.done) break;
			seen.delete(oldest.value);
		}
	};
	return {
		record(callId, raw) {
			const reason = sanitizeExecutionReason(raw);
			if (reason === undefined || typeof callId !== "string" || callId.length === 0) return reason;
			seen.delete(callId);
			seen.set(callId, reason);
			trim();
			return reason;
		},
		recall(callId) {
			return typeof callId === "string" ? seen.get(callId) : undefined;
		},
		recallForCall(ref) {
			const own = this.recall(ref.callId);
			if (own !== undefined) return own;
			return this.recall(ref.parentToolCallId);
		},
		recent(limit = LEDGER_LIMIT) {
			return [...seen.entries()]
				.slice(-limit)
				.reverse()
				.map(([callId, reason]) => ({ callId, reason }));
		},
		get size() {
			return seen.size;
		},
		clear() {
			seen.clear();
		},
	};
}

/**
 * 进程内共享的那一份：run_code 写，审核引擎读。
 * 必须走 processSingleton —— pi 给每个扩展单独建 jiti 实例，模块级变量不跨扩展共享。
 */
export function ptcReasonLedger(): PtcReasonLedger {
	return processSingleton("ptc-reason-ledger", () => createPtcReasonLedger());
}

/** 脚本正文的摘要，给审核侧对齐「理由 ↔ 是哪一段代码」用 */
export function ptcCodeDigest(code: string): string {
	return createHash("sha256").update(code, "utf8").digest("hex");
}
