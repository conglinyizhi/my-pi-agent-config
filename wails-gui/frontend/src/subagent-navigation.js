// subagent-navigation.js — 轮询层 selection 归一化与 timeline 自动跟随决策
//
// 把 SubagentsView.poll() 里最高风险的两段分支逻辑抽成纯函数，Node 可直接测试：
//   - reconcileNavigation({ viewLevel, selectedId, selectedEventId }, workers)：
//     只归一化 selection 状态，不碰任何滚动值；绝不变异入参 state 或 workers。
//     事件存在性一律经 readerEvents(worker) 判定 —— readerEvents 仍是事件序列
//     的唯一构造来源。
//   - shouldFollowTimeline({ viewLevel, selectedId, workers, atBottom })：
//     仅在 timeline 层、selected worker 存在、且读取者停留在底部（跟随最新，
//     非“已冻结”）时返回 true；agents/event、缺失 selection/worker、冻结阅读
//     （atBottom=false）一律 false。
//
// 归一化规则（与 Vue poll 分支一一对应）：
//   - agents/timeline 上有效的 selected worker → 保持原层级与原 selection；
//     agents 层有效 selection 不会因为“它存在”而被清掉。
//   - event 层：worker 在且事件在 → 全量保留；worker 在但事件消失 → 回 timeline，
//     保留 selectedId，selectedEventId 置 null（由 Vue 负责恢复阅读位置）。
//   - 任何层级：selectedId 非空但 worker 已不存在 → 回 agents，两个 ID 置 null。
//   - selectedId 为空 → 归一化到 agents，清掉遗留 selectedEventId。

import { readerEvents } from "./subagent-reader.js";

const AGENTS = "agents";
const TIMELINE = "timeline";
const EVENT = "event";

export function reconcileNavigation({ viewLevel, selectedId, selectedEventId }, workers) {
  const list = Array.isArray(workers) ? workers : [];
  const worker = selectedId != null ? list.find((w) => w.id === selectedId) : undefined;

  if (selectedId == null) {
    return { viewLevel: AGENTS, selectedId: null, selectedEventId: null };
  }
  if (!worker) {
    return { viewLevel: AGENTS, selectedId: null, selectedEventId: null };
  }
  if (viewLevel === EVENT) {
    const events = readerEvents(worker);
    const eventAlive = selectedEventId != null && events.some((e) => e.id === selectedEventId);
    if (eventAlive) {
      return { viewLevel: EVENT, selectedId, selectedEventId };
    }
    return { viewLevel: TIMELINE, selectedId, selectedEventId: null };
  }
  return { viewLevel, selectedId, selectedEventId };
}

export function shouldFollowTimeline({ viewLevel, selectedId, workers, atBottom }) {
  if (viewLevel !== TIMELINE || !atBottom) return false;
  if (selectedId == null) return false;
  const worker = Array.isArray(workers) ? workers.find((w) => w.id === selectedId) : undefined;
  return !!worker;
}
