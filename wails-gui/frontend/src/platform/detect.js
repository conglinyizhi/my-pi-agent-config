// 平台选择：同一份前端产物同时服务 Electron 与 Wails，按宿主注入的东西认。
//
// Electron 走 preload 的 window.piGui；Wails 注入 window.go / window.runtime。
// 这样切引擎不用改构建，也不用维护两份 dist。
import { createElectronPlatform } from "./electron.js";
import { createWailsPlatform } from "./wails.js";

export function createPlatform(scope = globalThis) {
  if (scope?.piGui) return createElectronPlatform(scope.piGui);
  return createWailsPlatform();
}

/** 当前宿主是谁，排障与日志用 */
export function platformKind(scope = globalThis) {
  if (scope?.piGui) return "electron";
  if (scope?.go || scope?.runtime) return "wails";
  return "unknown";
}
