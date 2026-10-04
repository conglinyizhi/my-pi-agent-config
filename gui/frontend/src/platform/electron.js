// Electron 平台适配器：把 preload 挂在 window.piGui 上的接口，包成与 Wails 版同形的对象。
//
// 视图不认识引擎，只吃这一个接口——所以从 Wails 切到 Electron 时，组件一行都不用改。

/**
 * @param {object} api preload 暴露的 window.piGui（测试可注入桩件）
 */
export function createElectronPlatform(api = globalThis.window?.piGui) {
  if (!api) throw new Error("Electron 宿主接口不可用：preload 没挂上 window.piGui");
  return {
    session: {
      getWindowName: () => api.session.getWindowName(),
      getInitData: () => api.session.getInitData(),
      markReady: () => api.session.markReady(),
      // 与 Wails 版一致：提交前统一 stringify，主进程只管写文件
      async submit(response) {
        await api.session.submit(JSON.stringify(response));
      },
      close: () => api.session.close(),
    },
    capabilities: {
      openFile: (file, line) => api.capabilities.openFile(file, line),
      copyText: (text) => api.capabilities.copyText(text),
    },
    gate: {
      loadReasons: () => api.gate.loadReasons(),
      saveReason: (content) => api.gate.saveReason(content),
      updateReason: (oldContent, newContent) => api.gate.updateReason(oldContent, newContent),
      deleteReason: (content) => api.gate.deleteReason(content),
    },
    // 审核设置：load = 读当前值（+维度元信息/取值范围），save = 提交 patch（后端校验并原子落盘）
    review: {
      load: () => api.review.load(),
      save: (patch) => api.review.save(patch),
    },
    subagents: {
      getStatus: (statusPath) => api.subagents.getStatus(statusPath),
      getDiagnostics: () => api.subagents.getDiagnostics(),
      getDiagnostic: (file) => api.subagents.getDiagnostic(file),
      deleteDiagnostic: (file) => api.subagents.deleteDiagnostic(file),
      queueSupplement: (payload) => api.subagents.queueSupplement(payload),
      withdrawSupplement: (payload) => api.subagents.withdrawSupplement(payload),
      mergeSupplements: (payload) => api.subagents.mergeSupplements(payload),
    },
  };
}
