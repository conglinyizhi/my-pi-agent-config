// model-selection — 当前 session 模型选择与设置
//
// /model:select [provider/model]：交互选择或精确设置当前 session 模型。
// set_session_model 工具：供主 agent 在当前对话中切换模型。
// 只调用 pi.setModel，不修改 settings.json 的 defaultModel。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

  pi.registerCommand("model:select", {
    description: "选择并设置当前 session 模型（不修改默认配置）：/model:select [provider/model]",
    handler: async (args, ctx) => {
      await setModel(pi, ctx, args.trim() || undefined);
    },
  });

  pi.registerTool({
    name: "set_session_model",
    label: "Set Session Model",
    description:
      "选择并设置当前主 agent session 的模型。传 provider/model 可精确设置；不传则打开模型选择器。只覆盖当前 session，不修改 defaultModel 默认配置。",
    promptSnippet: "Set the current session model without changing the default configuration",
    promptGuidelines: [
      "set_session_model 只修改当前 session 的模型，不写入 settings.json 的 defaultModel。",
      "需要精确指定时使用 provider/model；不确定可省略 model，让用户从已认证模型中选择。",
      "切换成功后，后续主 agent 轮次使用新模型；已经启动的 worker 不受影响。",
    ],
    parameters: Type.Object({
      model: Type.Optional(Type.String({
        description: "Optional exact model spec in provider/model form. Omit to open the interactive selector.",
      })),
    }),
    async execute(_toolCallId, params: { model?: string }, _signal, _onUpdate, ctx) {
      const result = await setModel(pi, ctx, params.model);
      if (result.ok) {
        return {
          content: [{ type: "text", text: `当前 session 模型：${modelLabel(result.model)}（仅本 session 生效）` }],
          details: { provider: result.model.provider, model: result.model.id, persistedDefault: false },
        };
      }
      return {
        content: [{ type: "text", text: failureText(result) }],
        details: { error: result.reason },
      };
    },
  });
}
