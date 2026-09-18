/**
 * 「没人接管的返航」通知文案。
 *
 * 暂存把控制权交回主 agent 之后，批次还在后台跑。如果它跑完了而没人接管
 * （主 agent 忘了续、或者当时没在跑），结果就会静静地落在地上 —— 这条消息是那道兜底。
 *
 * 抽成纯函数是为了能测：它的失败模式恰恰是「什么都不发生」，现场看不出来。
 */

import type { BatchItemResult } from "./batch.ts";

/** 单个 worker 的简报行；过长的输出在这里截断，完整结果在 details 里 */
export function formatReturnLine(result: BatchItemResult): string {
  const err = result.errorMessage ? ` error=${result.errorMessage.slice(0, 200)}` : "";
  return `#${result.index + 1} ${result.status.toUpperCase()}${err}\n  ${(result.output ?? "").trim().slice(0, 800)}`;
}

export function formatUnclaimedReturn(batchId: string, results: BatchItemResult[]): string {
  const lines = results.map(formatReturnLine);
  const body =
    lines.length > 0
      ? lines.join("\n\n")
      : "（批次异常结束，没有拿到结果；用 /subagent:gui 看最后一次状态快照）";
  return [
    `[subagent 返航] 批次 ${batchId} 跑完了，但没人接管结果`,
    "（你上次看到它时，它还暂存在检查点上）",
    "",
    body,
  ].join("\n");
}
