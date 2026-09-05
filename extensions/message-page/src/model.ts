import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const BACK_LABEL = "← 返回上一级";

/**
 * 两级选择器：先选供应商（provider），再选该供应商下的具体模型。
 * 第二级列表末尾提供一个“返回上一级”的特殊项跳回供应商列表。
 * 返回选中的模型；用户取消时返回 undefined。
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

  // 无 UI（print/json/rpc 无交互）时直接取第一个可用的
  if (!ctx.hasUI) {
    return available[0];
  }

  // 按供应商分组，保持稳定顺序
  const providers = Array.from(new Set(available.map((m) => m.provider))).sort();

  // 外层循环：选供应商
  for (;;) {
    const provLabels = providers.map((p) => {
      const count = available.filter((m) => m.provider === p).length;
      return `${p}（${count} 个模型）`;
    });
    const chosenProv = await ctx.ui.select("选择供应商：", provLabels);
    if (chosenProv === undefined) return undefined; // 用户取消
    const prov = providers[provLabels.indexOf(chosenProv)];
    if (!prov) continue;

    // 内层循环：选该供应商下的模型，可返回上一级
    const models = available.filter((m) => m.provider === prov);
    for (;;) {
      const modelLabels = models.map(
        (m) => `${m.id} — ${m.name && m.name !== m.id ? m.name : ""}`.trim(),
      );
      const items = [...modelLabels, BACK_LABEL];
      const chosen = await ctx.ui.select(`【${prov}】选择模型：`, items);
      if (chosen === undefined) return undefined; // 用户取消
      if (chosen === BACK_LABEL) break; // 返回供应商列表
      const idx = modelLabels.indexOf(chosen);
      if (idx >= 0) return models[idx];
    }
  }
}
