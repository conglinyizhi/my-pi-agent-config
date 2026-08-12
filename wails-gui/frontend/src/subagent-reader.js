// subagent-reader.js — 对话事件列表与上一条/下一条边界逻辑
//
// 为 Vue 三级浏览提供唯一数据接口，事件顺序与边界判断只在这里维护：
//   - readerEvents(worker)：timeline 原样保留（对象引用与顺序不变、不改入参数组），
//     末尾追加非空 output/stderr 的合成 terminal 记录。
//   - eventIndex(events, eventId)：事件下标，未知返回 -1。
//   - adjacentEventId(events, eventId, direction)：上一条/下一条，direction 仅 -1|1，
//     越界 / 未知 eventId / 非法方向一律返回 null。
//
// 合成 ID 碰撞策略：原 timeline ID 来自协议 opaque 字符串（assistant msg.id /
// toolCallId）或合成前缀（assistant-/tool-/lifecycle-），并不保证保留命名空间，
// 因此扁平 ID（如 "terminal-output"）存在碰撞风险。这里改用稳定前缀
// synthetic-terminal-*，并与现有事件 ID 去重（重名则追加 -N 兜底），确保不碰撞。

const TERMINAL_PREFIX = "synthetic-terminal";
const TERMINAL_OUTPUT_ID = `${TERMINAL_PREFIX}-output`;
const TERMINAL_STDERR_ID = `${TERMINAL_PREFIX}-stderr`;

/** 空字符串 / 纯空白视为无内容；非字符串一律不生成 terminal 记录 */
function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** 生成不与已有事件 ID 碰撞的合成 ID：重名时追加 -N */
function uniqueTerminalId(base, used) {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function readerEvents(worker) {
  const timeline = Array.isArray(worker?.timeline) ? worker.timeline : [];
  // 浅拷贝：保留原对象引用与顺序，绝不变异入参数组
  const events = [...timeline];
  const used = new Set(events.map((event) => event.id));
  if (hasText(worker?.output)) {
    events.push({
      id: uniqueTerminalId(TERMINAL_OUTPUT_ID, used),
      type: "terminal",
      stream: "output",
      text: worker.output,
    });
  }
  if (hasText(worker?.stderr)) {
    events.push({
      id: uniqueTerminalId(TERMINAL_STDERR_ID, used),
      type: "terminal",
      stream: "stderr",
      text: worker.stderr,
    });
  }
  return events;
}

export function eventIndex(events, eventId) {
  return Array.isArray(events) ? events.findIndex((event) => event.id === eventId) : -1;
}

export function adjacentEventId(events, eventId, direction) {
  if (direction !== -1 && direction !== 1) return null;
  const index = eventIndex(events, eventId);
  if (index < 0) return null;
  const next = index + direction;
  return next >= 0 && next < events.length ? events[next].id : null;
}
