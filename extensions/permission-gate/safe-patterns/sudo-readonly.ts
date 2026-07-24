/**
 * 安全模式：sudo + 只读命令
 *
 * 识别 sudo dmesg、sudo -n true、sudo cat 等只读操作。
 * 这些命令虽然包含 sudo，但不会修改系统状态，无需弹窗确认。
 */

import type { SafePatternHandler } from "./index";

/** 只读命令白名单（sudo 后紧跟的命令） */
const READONLY_COMMANDS = /^(dmesg|true|cat|head|tail|less|more|grep|find|ls|stat|file|which|whereis|type)\b/;

/**
 * sudo 只读安全模式处理器。
 * 匹配：sudo [-flags] <readonly-cmd> ...
 */
export const sudoReadonly: SafePatternHandler = (slices) => {
  const covered = new Set<number>();

  for (let i = 0; i < slices.length; i++) {
    const m = slices[i].match(/^sudo\s+(-\S+\s+)*(.*)/);
    if (!m) continue;
    const rest = m[2];
    if (READONLY_COMMANDS.test(rest)) {
      covered.add(i);
    }
  }

  return covered;
};
