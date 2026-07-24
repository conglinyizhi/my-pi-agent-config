/**
 * 安全模式：mktemp 临时目录生命周期
 *
 * 识别 var=$(mktemp -d) && ... && rm -rf "$var" 模式。
 * 这是标准的"创建临时目录 → 使用 → 清理"流程，rm -rf 的目标是
 * mktemp 生成的唯一随机路径，不存在误删用户数据的风险。
 */

import type { SafePatternHandler } from "./index";

// ---------------------------------------------------------------------------
// 扫描函数
// ---------------------------------------------------------------------------

/** 找出所有 var=$(mktemp ...) 赋值切片，返回变量名和索引 */
export function scanMktempAssign(slices: string[]): { index: number; varName: string }[] {
  const result: { index: number; varName: string }[] = [];
  for (let i = 0; i < slices.length; i++) {
    const m = slices[i].match(/^(\w+)=\$\(mktemp\b/);
    if (m) result.push({ index: i, varName: m[1] });
  }
  return result;
}

/** 从切片中提取所有 rm -rf 的目标参数 */
export function extractRmTargets(slice: string): string[] {
  const m = slice.match(/\brm\s+-rf?\s+(.*)/);
  if (!m) return [];
  const targets: string[] = [];
  const re = /("[^"]*"|\S+)/g;
  let t;
  while ((t = re.exec(m[1])) !== null) {
    targets.push(t[1]);
  }
  return targets;
}

/**
 * 从 rm 目标中提取变量名。
 * 支持：$var、"$var"、"${var}"、"$var/"、"$var/sub/path"
 * 返回 null 表示目标不是变量引用（如字面路径）。
 */
export function extractVarName(target: string): string | null {
  const m = target.match(/^"?\$\{?(\w+)\}?(\/[^"]*)?"?$/);
  if (m) return m[1];
  return null;
}

// ---------------------------------------------------------------------------
// 处理器
// ---------------------------------------------------------------------------

/**
 * mktemp 清理安全模式处理器。
 * 要求：mktemp 赋值在前，rm -rf "$var" 在后，且变量名一致。
 * 切片中所有 rm 目标都必须引用 mktemp 变量，否则不放行。
 */
export const mktempCleanup: SafePatternHandler = (slices) => {
  const assigns = scanMktempAssign(slices);
  if (assigns.length === 0) return new Set();

  // 构建变量名 → 最早赋值索引的映射
  const varFirstIndex = new Map<string, number>();
  for (const a of assigns) {
    if (!varFirstIndex.has(a.varName)) {
      varFirstIndex.set(a.varName, a.index);
    }
  }

  const covered = new Set<number>();

  for (let i = 0; i < slices.length; i++) {
    const targets = extractRmTargets(slices[i]);
    if (targets.length === 0) continue;

    // 所有 rm 目标都必须引用已赋值的 mktemp 变量
    let allSafe = true;
    for (const t of targets) {
      const varName = extractVarName(t);
      if (!varName) { allSafe = false; break; }
      const assignIdx = varFirstIndex.get(varName);
      if (assignIdx === undefined || assignIdx >= i) { allSafe = false; break; }
    }

    if (allSafe) {
      covered.add(i);
    }
  }

  return covered;
};
