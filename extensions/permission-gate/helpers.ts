import { dangerousPatterns, dangerousRules, type DangerousRule } from "./dangerous-patterns";
import { safePatternHandlers } from "./safe-patterns/index";

/** 匹配到的规则详情（给 GUI/TUI 展示用） */
export interface MatchedRule {
  pattern: string;
  tip: string;
  autoReject: boolean;
}

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

/** 获取第一个匹配的危险规则的 tip 消息 */
export function getDangerousTip(command: string): string | undefined {
  for (const rule of dangerousRules) {
    if (rule.pattern.test(command)) {
      return rule.tip;
    }
  }
  return undefined;
}

/** 获取所有匹配的危险规则（含 pattern、tip、autoReject） */
export function getMatchedRules(command: string): MatchedRule[] {
  return dangerousRules
    .filter(r => r.pattern.test(command))
    .map(r => ({
      pattern: r.pattern.source,
      tip: r.tip,
      autoReject: r.autoReject || false,
    }));
}

/** 检查命令是否匹配自动拒绝规则 */
export function isAutoReject(command: string): boolean {
  return dangerousRules.some(r => r.autoReject && r.pattern.test(command));
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
