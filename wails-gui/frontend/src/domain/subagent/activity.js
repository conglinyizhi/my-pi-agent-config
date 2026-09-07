// Worker 无事件时长分级：只提示诊断状态，不改变调度或自动中止。
export function activityState(worker, now = Date.now()) {
  if (!worker || !["starting", "running", "needs_approval"].includes(worker.status)) return { level: "terminal", label: "" };
  const raw = worker.lastActivityAt || worker.startedAt;
  const timestamp = Date.parse(raw || "");
  if (Number.isNaN(timestamp)) return { level: "unknown", label: "活动时间未知" };
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (worker.status === "needs_approval") return { level: "waiting", label: `等待权限 ${seconds}s` };
  if (seconds >= 300) return { level: "stalled", label: `长时间无事件 ${Math.floor(seconds / 60)}m` };
  if (seconds >= 60) return { level: "quiet", label: `可能卡住 ${Math.floor(seconds / 60)}m` };
  return { level: "active", label: `最近活动 ${seconds}s` };
}
