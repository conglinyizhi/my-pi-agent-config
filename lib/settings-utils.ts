/**
 * 设置文件工具
 *
 * 安全修改 settings.json，尽可能保留文件原有格式、缩进与注释。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 设置路径
// ---------------------------------------------------------------------------

/** 默认的 settings.json 路径 */
const SETTINGS_PATH = `${getAgentDir()}/settings.json`;

// ---------------------------------------------------------------------------
// 保存默认模型
// ---------------------------------------------------------------------------

/**
 * 保存默认 provider 和 model 到 settings.json，保留原有格式。
 *
 * 先用正则替换已有键的值；若正则未命中（键不存在或格式异常）则回退到
 * SettingsManager 的写入方式。
 *
 * @param provider  - 默认 provider ID（如 "opencode"）
 * @param modelId   - 默认 model ID
 * @param settingsPath - settings.json 路径（可选，默认 ~/.pi/agent/settings.json）
 */
export async function saveDefaultModelPreservingFormat(
  provider: string,
  modelId: string,
  settingsPath: string = SETTINGS_PATH,
): Promise<void> {
  const raw = readFileSync(settingsPath, "utf8");

  // 仅替换 defaultProvider 和 defaultModel 的值，保留文件其余格式、缩进与注释
  let updated = raw;
  updated = updated.replace(/("defaultProvider"\s*:\s*)"[^"]*"/, `$1"${provider}"`);
  updated = updated.replace(/("defaultModel"\s*:\s*)"[^"]*"/, `$1"${modelId}"`);

  // 如果正则未命中（键不存在或格式异常），回退到 SettingsManager
  if (updated === raw) {
    const settings = SettingsManager.create(".", getAgentDir());
    settings.setDefaultModelAndProvider(provider, modelId);
    await settings.flush();
    return;
  }

  writeFileSync(settingsPath, updated, "utf8");
}
