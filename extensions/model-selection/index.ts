// model-selection — 当前 session 模型选择与设置
//
// /model:select [provider/model]：交互选择或精确设置当前 session 模型。
// 只注册用户主动输入的命令；不向模型暴露模型选择工具。
// 只调用 pi.setModel，不修改 settings.json 的 defaultModel。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  modelLabel,
  setCurrentSessionModel,
  type ModelSelectionResult,
} from "../../lib/model-selection.ts";

function failureText(result: Extract<ModelSelectionResult, { ok: false }>): string {
  switch (result.reason) {
    case "cancelled": return "已取消模型选择。";
    case "invalid_spec": return "模型格式无效，请使用 provider/model。";
    case "not_found": return "找不到指定模型。";
    case "unauthenticated": return "模型未配置认证，无法切换。";
  }
}

async function setModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec?: string,
): Promise<ModelSelectionResult> {
  const result = await setCurrentSessionModel(pi, ctx, spec);
  if (ctx.hasUI) {
    if (result.ok) ctx.ui.notify(`当前 session 模型已切换为 ${modelLabel(result.model)}`, "info");
    else if (result.reason !== "cancelled") ctx.ui.notify(failureText(result), "warning");
  }
  return result;
}

export default function modelSelectionExtension(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT === "1") return;

  // 长命令名刻意包含 model / select / current / session / change / switch，
  // 方便用户按英文关键词搜索；短命令保留兼容。
  const command = {
    description: "选择并设置当前 session 模型（不修改默认配置）：[provider/model]",
    handler: async (args: string, ctx: ExtensionContext) => {
      await setModel(pi, ctx, args.trim() || undefined);
    },
  };
  pi.registerCommand("model:select-current-session-model", command);
  pi.registerCommand("model:change-current-session-model", command);
  pi.registerCommand("model:switch-current-session-model", command);
  pi.registerCommand("model:select", command);
}
