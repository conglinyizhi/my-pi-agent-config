import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";

/**
 * 自定义最终的 system prompt，去掉 pi 自动追加的日期和当前工作目录。
 *
 * 如果你想完全接管 system prompt（比如只读取 ~/.pi/agent/SYSTEM.md），
 * 可以把下面的 return 改成：
 *
 *   return { systemPrompt: await readSystemPromptFile() };
 *
 * 目前保留 pi 的其它自动追加项（AGENTS.md/CLAUDE.md 上下文、skills）。
 */
const AGENT_DIR = getAgentDir();

/** 返回 pi 自身配置仓库的上下文提示词文件路径 */
function getSelfPromptPath(): string {
  return `${AGENT_DIR}/extensions/system-prompt-filter/pi-self.md`;
}

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    let systemPrompt = event.systemPrompt;

    // 把 SYSTEM.md 里的占位符替换成当前 pi 安装的实际路径
    systemPrompt = systemPrompt.replaceAll("{{PI_README_PATH}}", getReadmePath());
    systemPrompt = systemPrompt.replaceAll("{{PI_DOCS_PATH}}", getDocsPath());
    systemPrompt = systemPrompt.replaceAll("{{PI_EXAMPLES_PATH}}", getExamplesPath());

    // 去掉自动追加的日期
    systemPrompt = systemPrompt.replace(/\nCurrent date: \d{4}-\d{2}-\d{2}/, "");

    // 在 pi 自身配置目录下工作时，注入专用的上下文提示词
    if (ctx.cwd === AGENT_DIR) {
      try {
        const selfPrompt = readFileSync(getSelfPromptPath(), "utf8");
        systemPrompt += `\n\n${selfPrompt}`;
      } catch { /* 文件不存在 */ }
    }

    return { systemPrompt };
  });
}
