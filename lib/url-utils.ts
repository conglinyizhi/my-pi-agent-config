/**
 * URL 工具函数
 */

// ---------------------------------------------------------------------------
// 域名提取
// ---------------------------------------------------------------------------

/**
 * 从 URL 提取域名标识符。
 *
 * 去掉常见 API 子域名前缀（api / www / v1 / v2），
 * 返回主域名中最有意义的部分。
 *
 * @param url - 完整的 HTTP(S) URL 字符串
 * @returns 域名标识符（如 "https://api.openai.com/v1" → "openai"）
 */
export function extractDomainId(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    let domain = hostname.replace(/^(api|www|v1|v2)\./i, "");
    const parts = domain.split(".");
    if (parts.length >= 2) return parts[0];
    return domain;
  } catch {
    const match = url.match(/https?:\/\/([^/]+)/);
    if (match) return match[1].split(".")[0];
    return "custom-provider";
  }
}
