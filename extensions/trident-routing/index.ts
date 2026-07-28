// trident-routing — 主Agent（林汐）工具权限控制
//
// 航母不亲自出击。禁止主Agent使用 write/edit 工具，
// 强制她通过 translate_task / task_create / subagent 调度工作。
// 
// /homeport 指令可临时解除限制，用于开发调试。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DISABLED_TOOLS = new Set(["write", "edit"]);

const GREETINGS = [
  "昨天的都归档了。今天有什么新计划……还是先聊会儿？",
  "甲板风有点凉。进来吧，简报室暖和。",
  "提督。咖啡在你右手边。有什么需要我调度的？",
];

let skipNextGreeting = false;
let homeportSession = false;

async function enterHomeport(pi: ExtensionAPI, ctx: any) {
  skipNextGreeting = true;
  homeportSession = true;
  ctx.ui.notify("⚓ 返回母港。本会话不限制工具，可自由编辑。", "info");
  await ctx.newSession({
    withSession: async (c: any) => {
      c.ui.notify("已进入母港。write/edit 可用，subagent 已禁用。", "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    // 启动时在 pi 配置目录 → 询问是否进母港
    if (event.reason === "startup" && ctx.cwd === getAgentDir()) {
      const ok = await ctx.ui.confirm(
        "⚓ 进入母港？",
        "检测到你在 pi 配置目录。要进入母港模式维修林汐吗？（母港模式保留 write/edit，禁用 subagent）"
      );
      if (ok) {
        pi.sendUserMessage("/homeport");
        return;
      }
    }

    const isHomeport = event.reason === "new" && skipNextGreeting;
    skipNextGreeting = false;

    // 非母港：限制 write/edit
    if (!isHomeport) {
      homeportSession = false;
      const active = pi.getActiveTools();
      const filtered = active.filter((t: string) => !DISABLED_TOOLS.has(t));
      if (filtered.length !== active.length) {
        pi.setActiveTools(filtered);
      }
    } else {
      // 母港：禁用 subagent
      const active = pi.getActiveTools();
      const filtered = active.filter((t: string) => t !== "subagent");
      if (filtered.length !== active.length) pi.setActiveTools(filtered);
    }

    // 新会话时注入开场白（母港模式跳过）
    if (event.reason === "new" && !isHomeport) {
      const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      pi.sendMessage({
        customType: "trident-greeting",
        content: greeting,
        display: true,
      });
    }
  });

  pi.registerCommand("homeport", {
    description: "返回母港：创建无限制的新会话（保留 write/edit，跳过开场白）",
    handler: async (args, ctx) => {
      await enterHomeport(pi, ctx);
    },
  });

  // 母港模式：替换系统提示词
  pi.on("before_agent_start", (event) => {
    if (!homeportSession) return;
    const promptPath = join(__dirname, "homeport-prompt.md");
    const prompt = existsSync(promptPath) ? readFileSync(promptPath, "utf-8") : "直接编码助手。";
    return { systemPrompt: prompt };
  });
}
