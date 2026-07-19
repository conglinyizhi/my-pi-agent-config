/**
 * 安全模式白名单
 *
 * 某些命令组合虽然包含危险关键词，但实际是安全的。
 * 每个处理器接收按 && 分割后的命令切片数组，返回被此模式标记为「安全」
 * 的切片索引集合。
 *
 * 判定规则：如果某次 bash 调用中，所有匹配危险模式的切片都被至少一个
 * 安全模式处理器覆盖，则视为安全命令，跳过确认弹窗。
 *
 * 添加新案例：新增一个处理器函数，push 到数组中即可。
 */

export type SafePatternHandler = (slices: string[]) => Set<number>;

export const safePatternHandlers: SafePatternHandler[] = [
  // ── 案例 1：/tmp 临时目录重建 ──
  // cd /tmp && rm -rf <dir> && mkdir <dir>
  // 前面可链其他命令（可选的 &&），后面也可链。
  // 要求 rm 和 mkdir 操作的是同一个目录名。
  (slices) => {
    const covered = new Set<number>();
    for (let i = 0; i < slices.length; i++) {
      const cdMatch = slices[i].match(/^cd\s+\/tmp$/);
      if (!cdMatch) continue;

      for (let j = i + 1; j < slices.length; j++) {
        const rmMatch = slices[j].match(/^rm\s+-rf?\s+(\S+)$/);
        if (!rmMatch) continue;
        const dir = rmMatch[1];

        for (let k = j + 1; k < slices.length; k++) {
          const mkMatch = slices[k].match(/^mkdir\s+(\S+)$/);
          if (mkMatch && mkMatch[1] === dir) {
            covered.add(i).add(j).add(k);
            break;
          }
        }
        if (covered.has(j)) break;
      }
      if (covered.has(i)) break;
    }
    return covered;
  },
];
