/**
 * Token 估算工具
 *
 * 基于字符类型的粗略 token 数量估算（非精确 tokenizer）。
 */

// ---------------------------------------------------------------------------
// 估算
// ---------------------------------------------------------------------------

/**
 * 根据字符数粗略估算 token 数量（英文经验规则：约 4 字符 ≈ 1 token）。
 *
 * 中文等宽字符语言请优先用 {@link estimateTextTokens}。
 *
 * @param chars - 字符数
 * @returns 估算的 token 数量
 */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

/**
 * 按字符类型估算一段文本的 token 数（浮点，便于流式小 chunk 累加后再取整）。
 *
 * 规则（粗略）：
 * - CJK / 假名 / 韩文 / 全角标点：约 1 字 ≈ 1 token
 * - ASCII：约 4 字 ≈ 1 token
 * - 其他 Unicode：约 2 字 ≈ 1 token
 *
 * @param text - 原始文本
 * @returns 估算的 token 数量（可能为小数）
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;

  let cjk = 0;
  let ascii = 0;
  let other = 0;

  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (isCjkLike(code)) {
      cjk++;
    } else if (code <= 0x7f) {
      ascii++;
    } else {
      other++;
    }
  }

  return cjk + ascii / 4 + other / 2;
}

/** 取整后的 token 估算，适合一次性统计完整文本。 */
export function estimateTextTokensRounded(text: string): number {
  return Math.round(estimateTextTokens(text));
}

function isCjkLike(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点
    (code >= 0xff00 && code <= 0xffef) || // 全角
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0xac00 && code <= 0xd7af) // 韩文音节
  );
}
