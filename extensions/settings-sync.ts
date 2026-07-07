/**
 * 设置同步扩展（单向写入 + 实时回写）
 *
 * settings.tracked.json（git 跟踪，唯一真相源）
 *   │
 *   ▼ session_start（先同步，后注册 watch）
 * settings.json（pi 运行时配置，gitignore）
 *   │
 *   ▼ fs.watch 实时回写（防抖）
 * settings.tracked.json
 *
 * 规则：
 * 1. 启动时：tracked 的非黑名单字段覆盖 settings.json 对应字段，
 *    settings.json 的黑名单字段（系统自动修改的）保留不动。
 *    同步完成后才注册 watch，避免初始化写入触发回写。
 * 2. 运行时：settings.json 变化 → 防抖后回写非黑名单字段到 tracked。
 * 3. 退出时：兜底回写（仅 reason: "quit"）。
 * 4. 黑名单字段永远不进入 tracked。
 */

import { readFileSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
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
// 运行时/退出时：settings.json → tracked
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
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // 启动时：先同步，后注册 watch——两段逻辑分离，初始化写入不会触发回写
  pi.on("session_start", () => {
    // 1. 初始化同步：tracked → settings.json
    syncFromTracked();

    // 2. 关闭旧 watcher（reload/new/resume/fork 会重新进入这里）
    if (watcher) {
      watcher.close();
      watcher = null;
    }

    // 3. 注册 watch，后续 settings.json 变化时实时回写
    watcher = watch(SOURCE_PATH, () => {
      // 防抖：pi 写 settings.json 可能触发多次事件，等 200ms 合并
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        syncToTracked();
      }, 200);
    });
  });

  // 退出时：关 watcher + 兜底回写（仅真正退出）
  pi.on("session_shutdown", (event) => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (event.reason === "quit") {
      syncToTracked();
    }
  });
}
