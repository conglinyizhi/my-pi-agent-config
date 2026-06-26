/**
 * 错误工具函数
 *
 * 提供可重试网络错误的判断逻辑。
 */

// ---------------------------------------------------------------------------
// 正则常量
// ---------------------------------------------------------------------------

/**
 * 匹配可重试的网络/连接错误的正则表达式。
 *
 * 覆盖：过载、限流、服务不可用、连接中断、超时、重试延迟等常见瞬时错误。
 */
export const RETRYABLE_ERROR_RE =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

// ---------------------------------------------------------------------------
// 最小接口
// ---------------------------------------------------------------------------

/** 用于判断可重试错误所需的最小消息字段 */
interface ErrorLikeMessage {
  role: string;
  stopReason?: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// 判断函数
// ---------------------------------------------------------------------------

/**
 * 判断一条 assistant 消息是否表示可重试的网络/连接错误。
 *
 * 典型场景：agent 因瞬时错误终止，但可能会自动重试。
 *
 * @param msg - 消息对象（至少包含 role、stopReason、errorMessage 字段）
 * @returns 如果是可重试错误则返回 true
 */
export function isRetryableError(msg: ErrorLikeMessage): boolean {
  if (msg.role !== "assistant") return false;
  return (
    msg.stopReason === "error" &&
    typeof msg.errorMessage === "string" &&
    RETRYABLE_ERROR_RE.test(msg.errorMessage)
  );
}
