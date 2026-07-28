// electron-gui.mjs — pi 扩展 GUI 公共函数
// 用于 permission-gate、trident-queue 等 Electron GUI

import { readFileSync, writeFileSync } from "node:fs";

/**
 * HTML 转义（用于嵌入 HTML 内容）
 */
export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * HTML 属性值转义
 */
export function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 读取请求 JSON 文件。
 * @returns 解析后的对象，或 null
 */
export function loadRequest(requestFile, responseFile) {
  try {
    return JSON.parse(readFileSync(requestFile, "utf-8"));
  } catch {
    try { writeFileSync(responseFile, JSON.stringify({ cancelled: true })); } catch {}
    return null;
  }
}

/**
 * 安全写入响应 JSON。
 */
export function writeResponse(responseFile, data) {
  try {
    writeFileSync(responseFile, JSON.stringify(data));
  } catch {}
}

/**
 * 窗口关闭时确保有响应。
 * @param {string} responseFile
 * @param {object} fallback - 兜底响应
 */
export function onWindowClosed(responseFile, fallback) {
  return () => {
    try {
      const { existsSync } = require("node:fs");
      if (!existsSync(responseFile)) {
        writeFileSync(responseFile, JSON.stringify(fallback));
      }
    } catch {}
  };
}
