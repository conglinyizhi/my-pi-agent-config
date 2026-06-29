/**
 * /open-editor 命令扩展
 *
 * 用设置文件中指定的编辑器打开目录或文件。
 * 无参数时打开当前工作目录，默认编辑器为 code。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 从 settings.json 中读取 editor 字段，未配置则返回 "code" */
function getEditor(): string {
  try {
    const raw = JSON.parse(
      readFileSync(`${getAgentDir()}/settings.json`, "utf8"),
    );
    return (raw.editor as string) || "code";
  } catch {
    return "code";
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("open-editor", {
    description: "用外部编辑器打开文件或目录，无参数时打开当前工作目录",
    handler: async (args, ctx) => {
      const editor = getEditor();
      const targetPath = args.trim()
        ? resolve(ctx.cwd, args.trim())
        : ctx.cwd;

      if (!existsSync(targetPath)) {
        ctx.ui.notify(`路径不存在: ${targetPath}`, "error");
        return;
      }

      const proc = spawn(editor, [targetPath], {
        detached: true,
        stdio: "ignore",
        cwd: ctx.cwd,
      });
      proc.unref();

      ctx.ui.notify(
        `已用 ${editor} 打开: ${targetPath}`,
        "info",
      );
    },
  });
}
