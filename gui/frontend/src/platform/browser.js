// Browser adapter 的 mock 实现：与 Wails adapter 保持相同形状，未来以 HTTP/SSE 实现替换。

/** 深拷一份审核设置（预览里改的是副本，不动调用方给的对象） */
function cloneSettings(settings) {
  return {
    llm: { ...(settings?.llm || {}) },
    classifier: { ...(settings?.classifier || {}) },
    dimensions: (settings?.dimensions || []).map((dim) => ({ ...dim })),
    warnings: [...(settings?.warnings || [])],
  };
}

export function createBrowserPlatform(initData, { onSubmit = () => {}, onOpenFile = () => {}, onCopyText } = {}) {
  let reasons = [];
  let workers = Array.isArray(initData?.workers) ? initData.workers : [];
  // 审核设置：浏览器预览里只改内存（真落盘要过 CLI，浏览器里没这条路），
  // 但有则改之、无则明说，不假装保存成功。
  let reviewSettings = initData?.settings ? cloneSettings(initData.settings) : null;
  const reviewSpecs = Array.isArray(initData?.specs) ? initData.specs : [];
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
    review: {
      async load() {
        if (!reviewSettings) return { ok: false, error: "浏览器预览没有内置审核设置（initData.settings 缺）" };
        return { ok: true, settings: cloneSettings(reviewSettings), specs: reviewSpecs, limits: initData?.limits, paths: initData?.paths };
      },
      async save(patch) {
        if (!reviewSettings) return { ok: false, error: "浏览器预览没有内置审核设置（initData.settings 缺）" };
        const changed = [];
        for (const group of ["llm", "classifier"]) {
          const next = patch?.[group];
          if (!next) continue;
          for (const [key, value] of Object.entries(next)) {
            if (reviewSettings[group][key] !== value) changed.push(`${group}.${key}: ${reviewSettings[group][key]} → ${value}`);
            reviewSettings[group][key] = value;
          }
        }
        for (const dim of patch?.dimensions ?? []) {
          const row = reviewSettings.dimensions.find((d) => d.id === dim.id);
          if (!row) continue;
          for (const key of ["enabled", "above", "below", "action"]) {
            if (dim[key] === undefined) continue;
            if (row[key] !== dim[key]) changed.push(`${dim.id}.${key}: ${row[key]} → ${dim[key]}`);
            row[key] = dim[key];
          }
        }
        return { ok: true, changed, settings: cloneSettings(reviewSettings), specs: reviewSpecs, limits: initData?.limits, paths: initData?.paths };
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
