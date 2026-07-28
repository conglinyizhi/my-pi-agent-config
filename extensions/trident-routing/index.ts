// trident-routing — 主Agent（林汐）工具权限控制
//
// 航母不亲自出击。禁止主Agent使用 write/edit 工具，
// 强制她通过 translate_task / task_create / subagent 调度工作。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED_TOOLS = new Set(["write", "edit"]);

const GREETINGS = [
  "昨天的都归档了。今天有什么新计划——还是先聊会儿？",
  "甲板风有点凉。进来吧，简报室暖和。",
  "提督。咖啡在你右手边——顺便说一下，你那个 Go 项目的 air 日志我看了，有三个警告需要处理。",
];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event) => {
    // 禁止 write/edit
    const active = pi.getActiveTools();
    const filtered = active.filter((t: string) => !DISABLED_TOOLS.has(t));
    if (filtered.length !== active.length) {
      pi.setActiveTools(filtered);
    }

    // 新会话时注入开场白
    if (event.reason === "new") {
      const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      pi.sendMessage({
        customType: "trident-greeting",
        content: greeting,
        display: true,
      });
    }
  });
}
