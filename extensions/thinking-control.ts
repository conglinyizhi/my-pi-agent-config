import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("change-think-effort", {
    description: "切换思考强度",
    handler: async (_args, ctx) => {
      const current = pi.getThinkingLevel();

      // 探测当前模型不认可的档位（仅用于标注 *，不拦截选择）
      const unsupported: string[] = [];
      for (const level of ALL_LEVELS) {
        pi.setThinkingLevel(level);
        if (pi.getThinkingLevel() !== level && !unsupported.includes(level)) {
          unsupported.push(level);
        }
      }
      pi.setThinkingLevel(current);

      const hasUnstable = unsupported.length > 0;
      const choice = await ctx.ui.select(
        hasUnstable ? `当前: ${current}（带 * 的是不稳定选项）` : `当前: ${current}`,
        ALL_LEVELS.map((l) => {
          const star = hasUnstable && unsupported.includes(l) ? "*" : "";
          const cur = l === current ? " ←" : "";
          return `${star}${l}${cur}`;
        }),
      );

      if (choice) {
        const level = choice
          .replace(" ←", "")
          .replace(/^\*/, "") as Parameters<typeof pi.setThinkingLevel>[0];
        pi.setThinkingLevel(level);
        ctx.ui.notify(`已切换: ${level}`, "info");
      }
    },
  });
}
