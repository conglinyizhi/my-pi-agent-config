// trident-routing — 主Agent（林汐）工具权限控制
//
// 航母不亲自出击。禁止主Agent使用 write/edit 工具，
// 强制她通过 translate_task / task_create / subagent 调度工作。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED_TOOLS = new Set(["write", "edit"]);

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const filtered = active.filter((t: string) => !DISABLED_TOOLS.has(t));
    if (filtered.length !== active.length) {
      pi.setActiveTools(filtered);
    }
  });
}
