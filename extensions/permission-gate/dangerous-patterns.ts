/**
 * 危险命令模式定义
 *
 * 每个正则匹配一个危险命令类别。添加新类别：push 到数组中即可。
 */
export const dangerousPatterns: RegExp[] = [
  /(?<!git\s)\brm\s+(-rf?|--recursive)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*777/i,
];
