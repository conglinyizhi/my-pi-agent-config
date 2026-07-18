/**
 * 跨扩展协作：思维链异常截断输出自动续跑 ⇄ 任务完成通知
 *
 * thinking-only-continue 在判定需要自动续跑时调用 markSuppressTaskComplete()；
 * task-notification 在发送「任务完成」前调用 shouldSuppressTaskComplete()。
 *
 * 标志为进程内全局状态（单 pi 进程、多扩展共享）。
 */

let suppressTaskComplete = false;
let consecutiveContinues = 0;

/** 标记：即将/正在因异常截断输出自动续跑，抑制任务完成通知 */
export function markSuppressTaskComplete(): void {
  suppressTaskComplete = true;
}

/** 是否应跳过任务完成桌面通知 */
export function shouldSuppressTaskComplete(): boolean {
  return suppressTaskComplete;
}

/** 清除抑制（续跑成功产出正文，或放弃续跑时） */
export function clearSuppressTaskComplete(): void {
  suppressTaskComplete = false;
}

/** 记录一次自动续跑，返回当前连续次数 */
export function recordContinueAttempt(): number {
  consecutiveContinues += 1;
  return consecutiveContinues;
}

/** 当前连续自动续跑次数 */
export function getContinueAttempts(): number {
  return consecutiveContinues;
}

/** 正文恢复或会话切换时重置连续计数 */
export function resetContinueAttempts(): void {
  consecutiveContinues = 0;
}

/** 会话切换 / 用户新输入时的全量复位 */
export function resetContinuationGuard(): void {
  suppressTaskComplete = false;
  consecutiveContinues = 0;
}
