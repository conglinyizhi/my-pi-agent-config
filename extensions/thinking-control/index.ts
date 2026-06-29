import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

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

      if (available.length === 0) {
        ctx.ui.notify("当前模型不支持调整思考深度", "warning");
        return;
      }

      const choice = await ctx.ui.select(
        `当前: ${current}`,
        available.map((l) => (l === current ? `${l} ←` : l)),
      );

      if (choice) {
        const level = choice.replace(" ←", "");
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
