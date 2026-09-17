// tool-args.ts — subagent 工具参数的兼容折叠
//
// 背景：schema 里 task 装的是「字符串 | 简报 | 简报数组」，模型很容易顺手写成
// 复数的 tasks。校验发生在派发之前，写错的代价是一个完整来回：报错 + 重发，
// 那份简报还要在上下文里多留两遍（2026-09-17 实际踩过）。
//
// prepareArguments 在 schema 校验之前运行，是 pi 官方的兼容口子，
// 内置的 edit 工具就用它折叠旧的 oldText/newText 写法。

/**
 * 把误写的 `tasks` 折回 `task`，其它形状原样返回。
 *
 * 只在「有 tasks 且没有 task」时动手，不覆盖已经正确的参数；
 * 返回新对象，不改调用方的输入。
 */
export function normalizeSubagentArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const a = args as Record<string, unknown>;
  if ("task" in a || !("tasks" in a)) return args;
  const { tasks, ...rest } = a;
  return { ...rest, task: tasks };
}
