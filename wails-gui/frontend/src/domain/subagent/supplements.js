// Supplement 草稿与队列的纯逻辑：平台调用和 Vue 响应式状态留在 composable/View。

/**
 * 可收受补充指令的状态：排队中的 worker 也算——inbox 在 spawn 前已创建，
 * bridge 会在它启动后第一次工具结束时 claim 到该条消息。
 */
export function isActiveWorkerStatus(status) {
  return status === "queued" || status === "starting" || status === "running";
}

export function workerSupplements(worker) {
  return Array.isArray(worker?.supplements) ? worker.supplements : [];
}

export function pendingSupplements(worker) {
  return workerSupplements(worker).filter((entry) => entry && entry.state === "pending");
}

export function buildMainAgentHandoff(worker, draft) {
  if (!worker) return "";
  const parts = [];
  const trimmedDraft = typeof draft === "string" ? draft.trim() : "";
  if (trimmedDraft) parts.push(trimmedDraft);
  pendingSupplements(worker).forEach((entry, index) => {
    if (index > 0) parts.push(`--- Supplement ${index + 1} ---`);
    parts.push(entry.text);
  });
  return parts.join("\n\n");
}
