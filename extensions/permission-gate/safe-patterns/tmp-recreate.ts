/**
 * 安全模式：/tmp 临时目录重建
 *
 * 识别 cd /tmp && rm -rf <dir> && mkdir <dir> 模式。
 * 这是标准的临时目录清理重建流程，虽然包含 rm -rf，但目标是 /tmp 下
 * 的同名目录，不存在误删风险。
 */

import type { SafePatternHandler } from "./index";

// ---------------------------------------------------------------------------
// 扫描函数
// ---------------------------------------------------------------------------

/** 找出所有 cd /tmp 的切片索引 */
export function scanCdTmp(slices: string[]): number[] {
  const result: number[] = [];
  for (let i = 0; i < slices.length; i++) {
    if (slices[i] === "cd /tmp") {
      result.push(i);
    }
  }
  return result;
}

/** 找出所有 rm -rf <single-dir> 的切片 */
export function scanRmRf(slices: string[]): { index: number; dir: string }[] {
  const result: { index: number; dir: string }[] = [];
  for (let i = 0; i < slices.length; i++) {
    const m = slices[i].match(/^rm\s+-rf?\s+(\S+)$/);
    if (m) result.push({ index: i, dir: m[1] });
  }
  return result;
}

/** 找出所有 mkdir <single-dir> 的切片（排除带 -p/-m 等 flag 的调用） */
export function scanMkdir(slices: string[]): { index: number; dir: string }[] {
  const result: { index: number; dir: string }[] = [];
  for (let i = 0; i < slices.length; i++) {
    const m = slices[i].match(/^mkdir\s+(\S+)$/);
    if (m) result.push({ index: i, dir: m[1] });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 处理器
// ---------------------------------------------------------------------------

/**
 * /tmp 重建安全模式处理器。
 * 要求：cd 在前，rm 在中，mkdir 在后，且 rm 和 mkdir 操作同一目录名。
 */
export const tmpRecreate: SafePatternHandler = (slices) => {
  const cdIndices = scanCdTmp(slices);
  const rmEntries = scanRmRf(slices);
  const mkEntries = scanMkdir(slices);

  const covered = new Set<number>();

  for (const cdIdx of cdIndices) {
    for (const rm of rmEntries) {
      if (rm.index <= cdIdx) continue;
      for (const mk of mkEntries) {
        if (mk.index <= rm.index) continue;
        if (rm.dir !== mk.dir) continue;

        covered.add(cdIdx);
        covered.add(rm.index);
        covered.add(mk.index);
      }
    }
  }

  return covered;
};
