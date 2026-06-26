import { readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AuthEntry {
  type?: string;
  key?: string;
}

export type AuthJson = Record<string, AuthEntry>;

const PI_AUTH_PATH = `${getAgentDir()}/auth.json`;

/** 读取并解析指定路径的 auth JSON，失败时返回空对象。 */
export function loadAuthJsonPath(path: string): AuthJson {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as AuthJson;
  } catch {
    return {};
  }
}

/** 读取并解析 ~/.pi/agent/auth.json，失败时返回空对象。 */
export function loadAuthJson(): AuthJson {
  return loadAuthJsonPath(PI_AUTH_PATH);
}

/** 从 ~/.pi/agent/auth.json 获取指定 provider 的 API key。 */
export function getApiKey(providerId: string): string | undefined {
  const auth = loadAuthJson();
  const entry = auth[providerId];
  if (entry?.type === "api_key" && entry.key) return entry.key;
  if (entry?.key) return entry.key;
  return undefined;
}

// ---------------------------------------------------------------------------
// 密钥遮盖
// ---------------------------------------------------------------------------

/**
 * 遮盖敏感密钥，仅展示首尾部分。
 *
 * 规则：
 * - 长度 ≤ 8  → 原样展示
 * - 长度 > 8  → 前 6 位 + "…" + 后 4 位
 *
 * @param key - 原始密钥字符串
 * @returns 遮盖后的展示字符串
 */
export function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
