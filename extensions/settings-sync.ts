/**
 * 设置同步扩展
 *
 * 从 settings.json 中提取有意义的用户配置字段，写入 settings.tracked.json。
 * 这样 settings.json（含运行时自动修改的字段如 lastChangelogVersion）可以被
 * .gitignore 忽略，而 settings.tracked.json 保持 git 仓库干净。
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

const AGENT_DIR = getAgentDir();
const SOURCE_PATH = `${AGENT_DIR}/settings.json`;
const TRACKED_PATH = `${AGENT_DIR}/settings.tracked.json`;

// ---------------------------------------------------------------------------
// 需要保留的字段白名单
// ---------------------------------------------------------------------------

/** 有意义的用户配置字段——其余字段（如 lastChangelogVersion）不写入 tracked 文件 */
const TRACKED_KEYS = new Set([
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "npmCommand",
  "packages",
  "theme",
]);

// ---------------------------------------------------------------------------
// 核心逻辑
// ---------------------------------------------------------------------------

/** 从原始 settings 中提取白名单字段 */
function extractTracked(raw: Record<string, unknown>): Record<string, unknown> {
  const tracked: Record<string, unknown> = {};
  for (const key of TRACKED_KEYS) {
    if (key in raw) {
      tracked[key] = raw[key];
    }
  }
  return tracked;
}

/** 将白名单字段同步到 tracked 文件 */
function syncTrackedFile(): void {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
  } catch {
    return; // settings.json 尚不存在或损坏，跳过
  }

  const tracked = extractTracked(raw);

  // 不覆盖内容完全相同的文件以避免无意义的 diff
  try {
    const existing = readFileSync(TRACKED_PATH, "utf8");
    if (existing.trim() === JSON.stringify(tracked, null, 2).trim()) return;
  } catch {
    // 文件不存在，正常写入
  }

  writeFileSync(TRACKED_PATH, JSON.stringify(tracked, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function settingsSyncExtension(pi: ExtensionAPI): void {
  // 每次会话启动时同步一次
  pi.on("session_start", () => syncTrackedFile());
}
