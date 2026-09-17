// bash-timeout.ts — 给 bash 工具补默认超时
//
// 背景：内建 bash 的 timeout 参数是「可选、无默认」，一条卡死的命令会把整个回合钉住，
// 只能靠人工中断（2026-09-17 实测过：一条误写的命令挂住，提督手动掐掉）。
// 这里在 schema 校验之前给缺省值，交给 pi 官方 execute 自己的超时实现
// （进程组 SIGKILL，不泄漏孤儿进程）。
//
// 与内存墙同一套哲学：默认给一个保守值，需要放宽的显式开口子
// （内存走 sandbox-allow 的 memoryMb，时间走 timeout 参数）。

/** 默认超时（秒）。构建/测试/安装这类活儿要显式传 timeout 放宽 */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 30;

/**
 * 参数里没有有效 timeout 时补默认值。
 *
 * 只在「缺 timeout / 不是正数」时动手，模型显式给的正整数一律尊重；
 * 返回新对象，不改调用方的输入。
 */
export function withDefaultTimeout(
  args: unknown,
  seconds: number = DEFAULT_BASH_TIMEOUT_SECONDS,
): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const a = args as Record<string, unknown>;
  const t = a.timeout;
  if (typeof t === "number" && Number.isFinite(t) && t > 0) return args;
  return { ...a, timeout: seconds };
}
