// gate.ts — 权限闸门扩展（bash 审批已迁移）
//
// 背景：原 gate.ts 在 tool_call hook 里拦截危险 bash 命令（白名单/规则/LLM 预审/
// GUI/TUI 审批）。2026-08 起 bash 已由 extensions/bash-guard.ts 同名接管——
// 检查、沙箱、审批链（自动判定 → LLM 预审 → 人类兜底）内聚在 bash 工具内部，
// 不再依赖 tool_call 事件链。因此本文件的 bash 审批 handler 已移除。
//
// 保留职责：startup 检测 pnpm 是否可用，未安装时在 TUI 通知用户（供 npm/npx
// 拦截 reason 附带安装指导引用，不依赖 bash hook）。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { checkNotificationSupport } from "../../lib/notify-send";

let pnpmChecked = false;
let pnpmAvailable = false;

/** 检测 pnpm 是否可用：spawnSync 跑 pnpm --version，ENOENT 视为未安装 */
function detectPnpm(): boolean {
  if (pnpmChecked) return pnpmAvailable;
  pnpmChecked = true;
  try {
    const r = spawnSync("pnpm", ["--version"], { stdio: "ignore" });
    pnpmAvailable = r.status === 0;
  } catch {
    pnpmAvailable = false;
  }
  return pnpmAvailable;
}

/** pnpm 未安装时的安装指导 */
const PNPM_INSTALL_HINT = "pnpm 未安装，请先要求用户安装 pnpm（npm install -g pnpm 或 curl -fsSL https://get.pnpm.io/install.sh | sh -），安装完成后再继续项目";

export default async function (pi: ExtensionAPI) {
  const support = await checkNotificationSupport();
  const _notificationReady = support.supported;

  // startup 检测 pnpm：未安装时 TUI 通知用户
  pi.on("session_start", (_event, ctx) => {
    if (!detectPnpm() && ctx.hasUI) {
      ctx.ui.notify(`⚠️ ${PNPM_INSTALL_HINT}`, "warning");
    }
  });
}
