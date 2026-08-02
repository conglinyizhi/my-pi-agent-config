import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("think", {
    description: "切换思考深度",
    handler: async (_args, ctx) => {
      const current = pi.getThinkingLevel();

      // 探测当前模型实际支持哪些级别
      const available: string[] = [];
      for (const level of ALL_LEVELS) {
        pi.setThinkingLevel(level);
        const actual = pi.getThinkingLevel();
        if (actual === level && !available.includes(level)) {
          available.push(level);
        }
      }
      pi.setThinkingLevel(current);

      const choice = await ctx.ui.select(
        `当前: ${current}`,
        ALL_LEVELS.map((l) => {
          const forced = !available.includes(l);
          const cur = l === current ? " ←" : "";
          return `${l}${forced ? "（强制）" : ""}${cur}`;
        }),
      );

      if (choice) {
        const level = choice
          .replace(" ←", "")
          .replace("（强制）", "") as Parameters<typeof pi.setThinkingLevel>[0];
        pi.setThinkingLevel(level);
        const applied = pi.getThinkingLevel();
        ctx.ui.notify(
          applied !== level
            ? `${level} 不支持，已设为 ${applied}`
            : `已切换: ${applied}`,
          applied !== level ? "warning" : "info",
        );
      }
    },
  });
}
