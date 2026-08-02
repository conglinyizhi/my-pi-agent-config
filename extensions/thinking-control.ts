import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("change-think-effort", {
    description: "切换思考强度",
    handler: async (_args, ctx) => {
      const current = pi.getThinkingLevel();
      const choice = await ctx.ui.select(
        `当前: ${current}`,
        ALL_LEVELS.map((l) => (l === current ? `${l} ←` : l)),
      );
      if (choice) {
        const level = choice.replace(" ←", "") as Parameters<typeof pi.setThinkingLevel>[0];
        pi.setThinkingLevel(level);
        ctx.ui.notify(`已切换: ${level}`, "info");
      }
    },
  });
}
