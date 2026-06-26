/**
 * 格式化工具函数
 *
 * 数字、容量等通用格式化。
 */

// ---------------------------------------------------------------------------
// Token 数量格式化
// ---------------------------------------------------------------------------

/**
 * 将 token 数量格式化为易读字符串。
 *
 * 规则：
 * - < 1000     → 原样（如 "512"）
 * - < 10000    → 保留一位小数 + k（如 "1.5k"）
 * - < 1000000  → 取整 + k（如 "128k"）
 * - >= 1000000 → 保留一位小数 + M（如 "2.0M"）
 *
 * @param count - token 数量
 * @returns 格式化后的字符串
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// 容量简写解析
// ---------------------------------------------------------------------------

/**
 * 解析容量简写为数字。
 *
 * 支持后缀：
 * - `k` / `K` → × 1_000
 * - `m` / `M` → × 1_000_000
 * - `g` / `G` → × 1_000_000_000
 *
 * 小数会被取整（如 "1.5k" → 1500）。
 *
 * @param s - 容量简写字符串（如 "1M", "256K", "2G"）
 * @returns 解析后的数值；无法解析时返回 undefined
 */
export function parseSize(s: string): number | undefined {
  const match = s.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmMgG]?)$/);
  if (!match) return undefined;

  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "k":
      return Math.round(num * 1000);
    case "m":
      return Math.round(num * 1000_000);
    case "g":
      return Math.round(num * 1000_000_000);
    default:
      return Math.round(num);
  }
}
