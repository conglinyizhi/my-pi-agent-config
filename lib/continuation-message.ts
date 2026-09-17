// continuation-message.ts — 续跑消息与自报完成哨兵：业务文本 + 「拉回理智」随机填充
//
// 背景：有模型会在思维链阶段疯狂打转（cot 里反复循环出不来）。实测在续跑消息
// 末尾附一段很长的高熵随机中英混合文本，能把它拽回正常输出。
//
// 填充本体已抽到 lib/random-filler.ts（词池 + 生成器），本模块只负责「怎么摆」：
//
//   1. 填充每次重新生成（generateRandomFiller），固定串会被模型记住并忽略。
//   2. 与业务文本的分界固定为**恰好一个空行**（appendLoopBreaker）。前半是出口
//      指令（「真完成了就去调那个工具」），必须保持完整可读；后半是噪声。空行是
//      让模型自己分辨「这是有价值的信息 / 这是填充」的唯一信号，别退化成两句连排。
//   3. 出口指令文本与识别它的字符串（BASH_HIT）必须同源，且识别必须**精确且严格**：
//      消息里叫模型执行哪条命令，拦截侧就只能认那一条。早期用 `cmd.includes(BASH_HIT)`
//      子串匹配，任何正文里提到过这句的命令（跑一段含该字面量的脚本、grep 搜它、
//      heredoc 里贴着它）都会被当成「模型报完成」，进而 abort 掉正在进行的工作。
//      为此有了 isBashHitCommand：只认整条命令就是它（允许引号/尾分号/空白差异）。

import { generateRandomFiller } from "./random-filler.ts";

/**
 * 续跑业务文本（出口指令）。末尾的 bash 出口是给「真完成了」的模型一条自报捷径：
 * 它一旦发现又收到这条消息，就调 bash 执行 BASH_HIT，父进程认这个信号直接收工。
 */
export const CONTINUE_PROMPT =
  "你似乎没有说完，我没有看到你的发言就终止了任务，请在content区域输出一些文本让我知道这个任务完成详情；如果你重复看到了这条消息，请调用 bash 工具：";

/** 自报完成的哨兵命令：既写在 CONTINUE_PROMPT 末尾，也被工具拦截侧匹配 */
export const BASH_HIT = "echo job done already";

/**
 * 这条 bash 命令是不是「模型在执行自报完成哨兵」。
 *
 * **只认整条命令就是哨兵本身**，不是「命令里出现了哨兵」。容忍的等价写法只有：
 * 首尾空白、内部连续空白、参数带引号、结尾一个分号。其余一律不算：
 *
 *   echo job done already                 → true
 *   echo "job done already"               → true
 *   echo 'job done already';              → true
 *   echo job done already && ls           → false（还有别的事要做）
 *   grep -r "echo job done already" .     → false（只是提到它）
 *   python3 - <<'PY' … 含该字面量 … PY    → false（正文里的字符串）
 *   echo job done already\nls             → false（多了第二条命令）
 */
export function isBashHitCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const collapsed = command.trim().replace(/\s+/g, " ");
  if (!collapsed) return false;
  const withoutSemicolon = collapsed.replace(/;\s*$/, "");
  // echo "job done already" / echo 'job done already' → 去引号后比对
  const unquoted = withoutSemicolon.replace(/^echo ("([^"]*)"|'([^']*)')$/, (_m, _raw, doubleQuoted, singleQuoted) =>
    `echo ${doubleQuoted ?? singleQuoted}`,
  );
  return unquoted === BASH_HIT;
}


/**
 * 业务文本 + 空行 + 填充。
 *
 * 分界契约就是这里的 `\n\n`：恰好一个空行。填充为空时原样返回 base，
 * 避免在不需要打断的路径上平白多出空行
 */
export function appendLoopBreaker(base: string, filler: string): string {
  if (!filler) return base;
  return `${base}\n\n${filler}`;
}

/**
 * 拼出最终续跑消息：业务文本（含 bash 出口）→ 恰好一个空行 → 高熵随机填充。
 *
 * 空行之后那段不传递信息，只用意外性把在思维链里打转的模型拽回来；
 * 留一个空行分界，是要让模型看得出「前半有价值、后半是填充」。
 * 填充缺省每次重新生成
 */
export function buildContinueMessage(filler: string = generateRandomFiller()): string {
  return appendLoopBreaker(CONTINUE_PROMPT + BASH_HIT, filler);
}
