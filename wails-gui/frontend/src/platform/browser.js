// Browser adapter 的 mock 实现：与 Wails adapter 保持相同形状，未来以 HTTP/SSE 实现替换。

export function createBrowserPlatform(initData, { onSubmit = () => {}, onOpenFile = () => {}, onCopyText } = {}) {
  let reasons = [];
  let workers = Array.isArray(initData?.workers) ? initData.workers : [];
  const copyText = onCopyText ?? (async (text) => {
    if (globalThis.navigator?.clipboard?.writeText) await globalThis.navigator.clipboard.writeText(text);
    return true;
  });

  return {
    session: {
      async getWindowName() { return "browser"; },
      async getInitData() { return initData || {}; },
      async markReady() {},
      async submit(response) { onSubmit(response); },
      async close() {}, // Browser 页面不因提交关闭；真实壳可改为路由返回。
    },
    capabilities: {
      async openFile(file, line) { onOpenFile(file, line); },
      copyText,
    },
    gate: {
      async loadReasons() { return reasons; },
      async saveReason(content) {
        const entry = { t: new Date().toISOString(), title: content.slice(0, 40), content };
        reasons = [entry, ...reasons.filter((reason) => reason.content !== content)].slice(0, 20);
      },
      async updateReason(oldContent, newContent) {
        const content = newContent.trim();
        if (!content) throw new Error("new reason content must not be empty");
        const entry = { t: new Date().toISOString(), title: content.slice(0, 40), content };
        const retained = reasons.filter((reason) => reason.content !== oldContent && reason.content !== content);
        reasons = [entry, ...retained].slice(0, 20);
      },
      async deleteReason(content) {
        reasons = reasons.filter((reason) => reason.content !== content);
      },
    },
    subagents: {
      async getStatus() { return JSON.stringify({ workers }); },
      async getDiagnostics() { return []; },
      async getDiagnostic() { return ""; },
      async deleteDiagnostic() { return false; },
      async queueSupplement(inboxId, text) {
        workers = workers.map((worker) => worker.inboxId === inboxId
          ? { ...worker, supplements: [...(worker.supplements || []), { id: `browser-${Date.now()}`, text, state: "pending" }] }
          : worker);
      },
      async withdrawSupplement(inboxId, entryId) {
        workers = workers.map((worker) => worker.inboxId === inboxId
          ? { ...worker, supplements: (worker.supplements || []).filter((entry) => entry.id !== entryId) }
          : worker);
      },
      async mergeSupplements(inboxId) {
        workers = workers.map((worker) => {
          if (worker.inboxId !== inboxId) return worker;
          const pending = (worker.supplements || []).filter((entry) => entry.state === "pending");
          if (pending.length < 2) return worker;
          const retained = worker.supplements.filter((entry) => entry.state !== "pending");
          return { ...worker, supplements: [...retained, { id: `browser-merged-${Date.now()}`, text: pending.map((entry) => entry.text).join("\n\n"), state: "pending" }] };
        });
      },
    },
  };
}
