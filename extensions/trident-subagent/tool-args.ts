// tool-args.ts — subagent 工具参数的兼容折叠与形状校验
//
// 背景：schema 里 task 装的是「字符串 | 简报 | 简报数组」，模型很容易顺手写成
// 复数的 tasks。校验发生在派发之前，写错的代价是一个完整来回：报错 + 重发，
// 那份简报还要在上下文里多留两遍（2026-09-17 实际踩过）。
//
// prepareArguments 在 schema 校验之前运行，是 pi 官方的兼容口子，
// 内置的 edit 工具就用它折叠旧的 oldText/newText 写法；它抛错会变成工具错误结果，
// 不会 spawn worker。
//
// 另一类手误是往 task 数组里漏进裸字符串（长简报写完忘了收尾的 `]`，
// 接着写的 `"timeout": 2700` 就掉进数组里）。这串东西会被当成一个完整任务派出去，
// 白烧一个 worker 的预算，所以在这里直接拒绝（2026-09-23 一天内踩了六次）。

/** 结构化简报里最长可回显的目标文本；够看清是哪个任务就够，不占满一行。 */
export const OBJECTIVE_HEAD_LIMIT = 40;

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

/** 值的简短类型描述，供报错文案指出实际收到的是什么。 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value;
}

/** 报错用的文本摘要：单行、有长度上限。 */
function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/**
 * 数组里的每个元素都必须是结构化简报。
 *
 * 这条规则不是洁癖：模型写长简报时少写一个 `]`，后面本来该在顶层的
 * `"timeout"` / `"sandbox_dir"` 就会掉进数组，被当成第二个 worker 的完整任务
 * 派出去（2026-09-23 一天六次）。裸字符串没有 `objective` 可核对，
 * 派工那一刻看不出任何异常，只能等 worker 跑完。
 *
 * 单个任务仍可用 `task: "纯文本说明"` 的兼容写法；要并行多个任务，
 * 每项都要写成对象，哪怕只填 objective。
 */
export function assertStructuredTaskArray(task: unknown): void {
  if (!Array.isArray(task)) return;
  task.forEach((item, index) => {
    const at = `task 数组第 ${index + 1} 个元素`;
    if (typeof item === "string") {
      throw new Error(
        `${at}是裸字符串「${summarize(item)}」。数组元素必须是结构化简报对象（至少含非空 objective）；`
        + `只有整个 task 传单个字符串时才允许纯文本。`
        + `若这串文本本来要当顶层参数用（如 timeout / sandbox_dir / model / skills），`
        + `请把它从数组里删掉，写成顶层键（并在需要时补上给 task 数组收尾的 ]）。`,
      );
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `${at}不是对象（收到 ${describeValue(item)}）。数组元素必须是结构化简报，例如 { "objective": "……" }。`,
      );
    }
    const objective = (item as { objective?: unknown }).objective;
    if (typeof objective !== "string" || objective.trim().length === 0) {
      throw new Error(
        `${at}缺少非空的 objective（收到 ${describeValue(objective)}）。`
        + `objective 要写 worker 要完成的具体目标；只写调查主题不算。`,
      );
    }
  });
}

/**
 * prepareArguments 的完整入口：先折叠 tasks，再校验数组元素形状。
 * 抛错即拦住本次派工，worker 一个都不会 spawn。
 */
export function prepareSubagentArgs(args: unknown): unknown {
  const normalized = normalizeSubagentArgs(args);
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    assertStructuredTaskArray((normalized as Record<string, unknown>).task);
  }
  return normalized;
}

/**
 * 取一条 task 参数的回显文本（objective 优先，最多 limit 字）。
 *
 * 派工行里逐 worker 回显用：误写的裸字符串、复制粘贴错位的简报，
 * 在派工那一刻就能看见，不用等 worker 跑完。
 */
export function taskHeadline(item: unknown, limit = OBJECTIVE_HEAD_LIMIT): string {
  const objective = item && typeof item === "object" && !Array.isArray(item)
    ? (item as { objective?: unknown }).objective
    : undefined;
  if (typeof objective !== "string" && typeof item !== "string") {
    // 不是简报：把收到的东西照实回显，误写的元素在派工行里一眼可见
    return item === undefined || item === null || typeof item === "object"
      ? `（缺 objective：${describeValue(objective)}）`
      : `（不是简报：${describeValue(item)} ${summarize(String(item))}）`;
  }
  const oneLine = (typeof item === "string" ? item : objective as string).replace(/\s+/g, " ").trim();
  if (!oneLine) return "（objective 为空）";
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}
