/**
 * 设置同步扩展（单向写入模式）
 *
 * settings.tracked.json（git 跟踪，唯一真相源）
 *   │
 *   ▼ session_start
 * settings.json（pi 运行时配置，gitignore）
 *   │
 *   ▼ session_shutdown (reason: "quit")
 * 回写到 settings.tracked.json
 *
 * 规则：
 * 1. 启动时：tracked 的非黑名单字段覆盖 settings.json 对应字段，
 *    settings.json 的黑名单字段（系统自动修改的）保留不动。
 * 2. 退出时：settings.json 的非黑名单字段回写到 tracked。
 * 3. 黑名单字段永远不进入 tracked。
 *
 * 不需要额外状态文件。
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
// 黑名单——这些字段由系统自动修改，不进入 tracked
// ---------------------------------------------------------------------------

const EXCLUDED_KEYS = new Set([
  "lastChangelogVersion",
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
]);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 读 JSON 文件，不存在则返回 null */
function readJSON(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 写入 JSON，内容无变化则跳过 */
function writeIfChanged(path: string, data: Record<string, unknown>): boolean {
  const newContent = JSON.stringify(data, null, 2) + "\n";
  try {
    if (readFileSync(path, "utf8") === newContent) return false;
  } catch { /* 文件不存在，正常写入 */ }
  writeFileSync(path, newContent, "utf8");
  return true;
}

/**
 * 提取非黑名单字段，按键名排序以保证序列化一致性。
 */
function extractNonExcluded(raw: Record<string, unknown>): Record<string, unknown> {
  const sortedKeys = Object.keys(raw)
    .filter((k) => !EXCLUDED_KEYS.has(k))
    .sort();
  const data: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    data[k] = raw[k];
  }
  return data;
}

// ---------------------------------------------------------------------------
// 启动时：tracked → settings.json
// ---------------------------------------------------------------------------

function syncFromTracked(): void {
  const trackedJson = readJSON(TRACKED_PATH);
  if (!trackedJson) return;

  const settingsJson = readJSON(SOURCE_PATH) ?? {};

  // 以 settings.json 为基底，用 tracked 的非黑名单字段覆盖
  const merged = { ...settingsJson };

  for (const [key, value] of Object.entries(trackedJson)) {
    if (EXCLUDED_KEYS.has(key)) continue;
    merged[key] = value;
  }

  // 如果 tracked 里没有但 settings.json 里有的非黑名单字段，
  // 说明 tracked 已删除该字段 → 从 settings.json 也删除
  for (const key of Object.keys(merged)) {
    if (!EXCLUDED_KEYS.has(key) && !(key in trackedJson)) {
      delete merged[key];
    }
  }

  writeIfChanged(SOURCE_PATH, merged);
}

// ---------------------------------------------------------------------------
// 退出时：settings.json → tracked
// ---------------------------------------------------------------------------

function syncToTracked(): void {
  const settingsJson = readJSON(SOURCE_PATH);
  if (!settingsJson) return;

  // 用 settings.json 的非黑名单字段重建 tracked
  const newTracked = extractNonExcluded(settingsJson);

  writeIfChanged(TRACKED_PATH, newTracked);
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function settingsSyncExtension(pi: ExtensionAPI): void {
  // 启动时：tracked → settings.json
  pi.on("session_start", () => syncFromTracked());

  // 退出时：settings.json → tracked（仅真正退出时，切换会话不回写）
  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit") {
      syncToTracked();
    }
  });
}
