// Supplement 草稿与队列的纯逻辑：平台调用和 Vue 响应式状态留在 composable/View。

export function isActiveWorkerStatus(status) {
  return status === "starting" || status === "running";
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
