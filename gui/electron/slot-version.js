// slot-version.js — 现在跑的是哪个槽、哪次提交
//
// A/B 切槽之后，窗口标题里没有版本就分不清在看哪一份。槽根目录有 manifest.json，
// 里面记着 sha / dirty / builtAt；槽名从路径上取（~/.pi/runtime/<组件>/<槽>/…）。

import { existsSync, readFileSync } from "node:fs";

/** manifest 路径 → "dev@a86b7d5" 这种标签；读不到就给空串（仓库里跑就是这种情况） */
export function versionLabelFrom(manifestPath, { exists = existsSync, read = (p) => readFileSync(p, "utf8") } = {}) {
  if (!manifestPath || !exists(manifestPath)) return "";
  try {
    const data = JSON.parse(read(manifestPath));
    const parts = String(manifestPath).split(/[\\/]/);
    const slot = parts[parts.length - 2] ?? "";
    const sha = typeof data?.sha === "string" ? data.sha.slice(0, 7) : "";
    if (!sha) return slot;
    return slot + "@" + sha + (data?.dirty === true ? "-dirty" : "");
  } catch {
    return "";
  }
}
