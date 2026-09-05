import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * 让用户从【已配置认证】的模型里挑一个，用于决策卡片分析。
 * 返回选中的模型；用户取消或无可用模型时返回 undefined。
 */
export async function pickModel(
  ctx: ExtensionContext,
): Promise<Model<Api> | undefined> {
  const all = ctx.modelRegistry.getAll();
  const available = all.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m));

  if (available.length === 0) {
    if (ctx.hasUI) {
      ctx.ui.notify("没有已配置认证的模型可用于分析", "warning");
    }
    return undefined;
  }

  if (ctx.hasUI) {
    const labels = available.map(
      (m) => `${m.provider}/${m.id} — ${m.name ?? m.id}`,
    );
    const chosen = await ctx.ui.select("选择决策卡片分析模型：", labels);
    if (chosen === undefined) {
      return undefined;
    }
    const idx = labels.indexOf(chosen);
    return idx >= 0 ? available[idx] : undefined;
  }

  // 无 UI（print/json/rpc 无交互）时用第一个可用的
  return available[0];
}
