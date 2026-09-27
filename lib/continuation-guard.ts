/**
 * 跨扩展协作：思维链异常截断输出自动续跑 ⇄ 任务完成通知
 *
 * for-grok-4-5 在判定需要自动续跑时调用 markSuppressTaskComplete()；
 * task-notification 在发送「任务完成」前调用 shouldSuppressTaskComplete()。
 *
 * 标志为进程内全局状态（单 pi 进程、多扩展共享）—— 写方和读方是两个扩展，
 * 所以必须真的共享：pi 给每个扩展单独建 jiti 实例（moduleCache: false），
 * 模块级变量在扩展之间不共享。这里曾经写成模块级 `let`，抑制标志写进 for-grok-4-5
 * 那一份、task-notification 读的是自己那一份，抑制完全失效（续跑期间照样弹完成通知）。
 * 挂到 globalThis 上（见 lib/process-singleton.ts）才是进程内唯一的一份。
 */

import { processSingleton } from "./process-singleton.ts";

interface ContinuationGuardState {
  /** 即将/正在因异常截断输出自动续跑：抑制任务完成通知 */
  suppressTaskComplete: boolean;
  /** 连续自动续跑次数 */
  consecutiveContinues: number;
}

const state = processSingleton<ContinuationGuardState>("continuation-guard", () => ({
  suppressTaskComplete: false,
  consecutiveContinues: 0,
}));

/** 标记：即将/正在因异常截断输出自动续跑，抑制任务完成通知 */
export function markSuppressTaskComplete(): void {
  state.suppressTaskComplete = true;
}

/** 是否应跳过任务完成桌面通知 */
export function shouldSuppressTaskComplete(): boolean {
  return state.suppressTaskComplete;
}

/** 清除抑制（续跑成功产出正文，或放弃续跑时） */
export function clearSuppressTaskComplete(): void {
  state.suppressTaskComplete = false;
}

/** 记录一次自动续跑，返回当前连续次数 */
export function recordContinueAttempt(): number {
  state.consecutiveContinues += 1;
  return state.consecutiveContinues;
}

/** 当前连续自动续跑次数 */
export function getContinueAttempts(): number {
  return state.consecutiveContinues;
}

/** 正文恢复或会话切换时重置连续计数 */
export function resetContinueAttempts(): void {
  state.consecutiveContinues = 0;
}

/** 会话切换 / 用户新输入时的全量复位（改的是共享那份的字段，不换引用） */
export function resetContinuationGuard(): void {
  state.suppressTaskComplete = false;
  state.consecutiveContinues = 0;
}
