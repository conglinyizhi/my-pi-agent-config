/**
 * sysprompt-view — 捕获最新的 system prompt，用 /sysprompt 命令查看。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

export default function (pi: ExtensionAPI) {
  let latestPrompt = "";

  pi.on("before_agent_start", async (event, _ctx) => {
    latestPrompt = event.systemPrompt;
  });

  pi.registerCommand("sysprompt", {
    description: "查看当前 system prompt（写入临时文件并用编辑器打开）",
    handler: async (_args, ctx) => {
      if (!latestPrompt) {
        ctx.ui.notify("尚无 system prompt，请先发起一次对话", "warn");
        return;
      }

      const tmpFile = execSync("mktemp -t pi-sysprompt-XXXXXX.md", {
        encoding: "utf-8",
      }).trim();

      execSync(`cat > "${tmpFile}"`, { input: latestPrompt });

      const editor = process.env.VISUAL || process.env.EDITOR || "kate";
      execSync(`${editor} "${tmpFile}"`, { stdio: "inherit" });

      ctx.ui.notify(`已打开: ${tmpFile}`, "info");
    },
  });
}
