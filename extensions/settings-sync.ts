/**
 * 设置同步扩展（双向合并模式）
 *
 * settings.json（pi 运行时配置源）←→ settings.tracked.json（git 跟踪快照）
 *
 * 合并规则：
 * 1. 黑名单字段（系统自动修改）只存在于 settings.json，不进入 tracked
 * 2. 独有字段互相补充：
 *    - settings.json 独有的非黑名单字段 → 写入 tracked
 *    - tracked 独有的非黑名单字段 → 反向写入 settings.json（运行时生效）
 * 3. 共有字段冲突（值不同）：
 *    - 比较 settings.json 非黑名单部分是否相比上次同步有实质变化
 *    - 有实质变化 → settings.json 优先（用户通过 /settings 改了配置）
 *    - 无实质变化 → tracked 优先（系统只改了黑名单字段如版本号，用户手动编辑了 tracked）
 *
 * 这样无论编辑哪个文件，配置都能保持同步，且系统自动刷新版本号不会干扰裁决。
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
const STATE_PATH = `${AGENT_DIR}/.pi-sync-state.json`;

// ---------------------------------------------------------------------------
// 黑名单——这些字段由系统自动修改，不进入 tracked，也不从 tracked 反向同步
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

/** 写入 JSON，内容无变化则跳过。返回是否实际写入 */
function writeIfChanged(path: string, data: Record<string, unknown>): boolean {
  const newContent = JSON.stringify(data, null, 2) + "\n";
  try {
    if (readFileSync(path, "utf8") === newContent) return false;
  } catch { /* 文件不存在，正常写入 */ }
  writeFileSync(path, newContent, "utf8");
  return true;
}

/** 深比较 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 提取非黑名单字段，按键名排序以保证序列化一致性。
 * 返回 { data, fingerprint }，fingerprint 用于判断是否有实质变化。
 */
function extractNonExcluded(raw: Record<string, unknown>): {
  data: Record<string, unknown>;
  fingerprint: string;
} {
  const sortedKeys = Object.keys(raw)
    .filter((k) => !EXCLUDED_KEYS.has(k))
    .sort();
  const data: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    data[k] = raw[k];
  }
  return { data, fingerprint: JSON.stringify(data) };
}

// ---------------------------------------------------------------------------
// 核心逻辑
// ---------------------------------------------------------------------------

function syncBidirectional(): void {
  const settingsJson = readJSON(SOURCE_PATH);
  if (!settingsJson) return;

  const trackedJson = readJSON(TRACKED_PATH) ?? {};
  const stateJson = readJSON(STATE_PATH) ?? {};

  // 上次同步时 settings.json 非黑名单字段的指纹
  const lastFingerprint: string | undefined =
    typeof stateJson.lastSettingsFingerprint === "string"
      ? stateJson.lastSettingsFingerprint
      : undefined;

  // 当前 settings.json 非黑名单字段
  const { data: curNonExcluded, fingerprint: curFingerprint } =
    extractNonExcluded(settingsJson);

  // settings.json 非黑名单部分是否有实质变化（排除系统自动修改）
  const settingsHasRealChange =
    lastFingerprint !== undefined && curFingerprint !== lastFingerprint;

  const newSettings = { ...settingsJson };
  const newTracked = { ...trackedJson };

  const allKeys = new Set([...Object.keys(settingsJson), ...Object.keys(trackedJson)]);

  for (const key of allKeys) {
    // 黑名单字段：确保不在 tracked 中
    if (EXCLUDED_KEYS.has(key)) {
      if (key in newTracked) delete newTracked[key];
      continue;
    }

    const inSettings = key in settingsJson;
    const inTracked = key in trackedJson;

    if (inSettings && inTracked) {
      // 两边都有 → 值不同时需要裁决
      if (!deepEqual(settingsJson[key], trackedJson[key])) {
        if (settingsHasRealChange) {
          // settings.json 有实质变化 → 用户通过 /settings 改了配置 → settings 优先
          newTracked[key] = settingsJson[key];
        } else {
          // settings.json 无实质变化 → 系统只改了黑名单字段 → tracked 优先
          newSettings[key] = trackedJson[key];
        }
      }
    } else if (inSettings && !inTracked) {
      // settings.json 独有 → 写入 tracked
      newTracked[key] = settingsJson[key];
    } else if (!inSettings && inTracked) {
      // tracked 独有 → 反向写入 settings.json（运行时生效）
      newSettings[key] = trackedJson[key];
    }
  }

  // 写入
  const sChanged = writeIfChanged(SOURCE_PATH, newSettings);
  const tChanged = writeIfChanged(TRACKED_PATH, newTracked);

  // 更新状态：记录本次同步后 settings.json 非黑名单部分的指纹
  if (sChanged || tChanged || lastFingerprint !== curFingerprint) {
    writeFileSync(
      STATE_PATH,
      JSON.stringify({ lastSettingsFingerprint: curFingerprint }, null, 2) + "\n",
      "utf8",
    );
  }
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function settingsSyncExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => syncBidirectional());
}
