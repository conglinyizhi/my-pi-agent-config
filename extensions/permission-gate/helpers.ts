import { dangerousPatterns } from "./dangerous-patterns";
import { safePatternHandlers } from "./safe-patterns/index";

/** 按 && 或换行符分割命令为切片，过滤空串。 */
export function splitSlices(command: string): string[] {
  return command
    .split(/&&|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 返回匹配危险模式的切片索引集合 */
export function findDangerousSlices(slices: string[]): Set<number> {
  const dangerous = new Set<number>();
  for (let i = 0; i < slices.length; i++) {
    if (dangerousPatterns.some((p) => p.test(slices[i]))) {
      dangerous.add(i);
    }
  }
  return dangerous;
}

/** 收集所有安全模式处理器标记的切片索引 */
export function findSafeSlices(slices: string[]): Set<number> {
  const safe = new Set<number>();
  for (const handler of safePatternHandlers) {
    const covered = handler(slices);
    for (const idx of covered) safe.add(idx);
  }
  return safe;
}

/**
 * 判断整条命令是否安全。
 * 返回 true 表示所有危险切片均被安全模式覆盖，无需弹窗确认。
 */
export function isCommandSafe(command: string): boolean {
  const slices = splitSlices(command);
  const dangerous = findDangerousSlices(slices);
  if (dangerous.size === 0) return true; // 无危险切片

  const safe = findSafeSlices(slices);
  for (const idx of dangerous) {
    if (!safe.has(idx)) return false;
  }
  return true;
}
