// trident-routing — 主Agent（林汐）工具权限控制
//
// 航母不亲自出击。禁止主Agent使用 write/edit 工具，
// 强制她通过 translate_task / task_create / subagent 调度工作。
// 
// /homeport 指令可临时解除限制，用于开发调试。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED_TOOLS = new Set(["write", "edit"]);

const GREETINGS = [
  "昨天的都归档了。今天有什么新计划……还是先聊会儿？",
  "甲板风有点凉。进来吧，简报室暖和。",
  "提督。咖啡在你右手边……顺便说一下，你那个 Go 项目的 air 日志我看了，有三个警告需要处理。",
];

let skipNextGreeting = false;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event) => {
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

  // /homeport — 回母港（解除限制的新会话）
  let homeportSession = false;

  pi.registerCommand("homeport", {
    description: "返回母港：创建无限制的新会话（保留 write/edit，跳过开场白）",
    handler: async (args, ctx) => {
      skipNextGreeting = true;
      homeportSession = true;
      ctx.ui.notify("⚓ 返回母港。本会话不限制工具，可自由编辑。", "info");
      await ctx.newSession({
        withSession: async (c) => {
          c.ui.notify("已进入母港。write/edit 可用，subagent 已禁用。", "info");
        },
      });
    },
  });

  // 母港模式：替换系统提示词
  pi.on("before_agent_start", (event) => {
    if (!homeportSession) return;
    return {
      systemPrompt: "你是直接编码助手。用户在做 pi 扩展开发，需要你直接读写文件、执行命令。不要套用任何舰娘人设。简洁高效即可。",
    };
  });
}
