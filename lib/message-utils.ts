/**
 * 消息工具函数
 *
 * 提供跨扩展复用的消息查询与摘要功能。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// 最小接口（兼容 AgentMessage / Message 等不同消息类型）
// ---------------------------------------------------------------------------

/** 消息内容片段 */
interface ContentPart {
  type: string;
  text?: string;
}

// ---------------------------------------------------------------------------
// 查找
// ---------------------------------------------------------------------------

/**
 * 从消息列表中查找最后一条 assistant 消息。
 *
 * @param messages - 消息数组（只需要包含 role 属性）
 * @returns 最后一条 assistant 消息；不存在则返回 undefined
 */
export function findLastAssistant<T extends { role: string }>(messages: T[]): T | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 输出提取
// ---------------------------------------------------------------------------

/**
 * 从消息列表中提取最后一条 assistant 的文本输出。
 *
 * @param messages - 消息数组（需要包含 role 和 content 属性；content 可能是数组或字符串）
 * @returns 最后一条 assistant 文本内容；不存在则返回空字符串
 */
export function getFinalOutput(messages: Array<{ role: string; content: string | ContentPart[] }>): string {
  const last = findLastAssistant(messages);
  if (!last) return "";

  const content = last.content;
  if (typeof content === "string") return content;

  for (const part of content) {
    if (part.type === "text" && part.text) return part.text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

/**
 * 从消息列表中提取最后一条 assistant 文本消息作为任务摘要。
 *
 * 优先取纯文本部分，截断到指定长度。
 *
 * @param messages - 消息数组
 * @param maxLen   - 摘要最大长度（默认 100）
 * @returns 摘要文本
 */
export function summarizeLastAssistantMessage(messages: AgentMessage[], maxLen = 100): string {
  const lastAssistant = findLastAssistant(messages);
  if (!lastAssistant) return "任务处理完成";

  const assistant = lastAssistant as AgentMessage & { content?: ContentPart[] };
  if (!assistant.content) return "任务处理完成";

  const textParts = assistant.content.filter((part: ContentPart) => part.type === "text");
  if (textParts.length === 0) return "任务处理完成";

  const fullText = textParts.map((part: ContentPart) => part.text ?? "").join(" ");
  return fullText.length > maxLen ? `${fullText.slice(0, maxLen)}...` : fullText;
}
