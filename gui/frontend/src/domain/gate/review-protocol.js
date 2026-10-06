// review-protocol.js — decode-only 审核的文本协议展示逻辑（纯函数，不碰 Vue / DOM）
//
// 协议（2026-10-06 起）：判可行时模型整段只回 [ok]（大小写不敏感）；判有风险时先写
// 档位标记 [<20] / [40] / [60]，再写一句说明。解析在 pi 侧（llm-review.ts 的
// extractReviewResult），这里只管渲染：档位文案、[ok] 占位、卡头该写谁的名字。
//
// 放这里而不是 .vue 里，是为了能用 node --test 覆盖。

/** 档位 → 文案：20 那一档是「不超过 20 字」，写成 <20 字；其余直接写数字 */
export function budgetLabel(budget) {
  if (budget === 20) return "<20 字";
  if (budget === 40) return "40 字";
  if (budget === 60) return "60 字";
  return "";
}

/** 判可行时模型只回 [ok]，reason 是空的：卡上把这枚标记露出来，别显示成空白 */
export function reasonText(review) {
  const reason = typeof review?.reason === "string" ? review.reason : "";
  if (reason) return reason;
  return review?.verdict === "safe" ? "[ok]" : "";
}

/** 这次的结论是不是分类器给的（有维度表就是） */
export function fromClassifier(review) {
  return Array.isArray(review?.dimensions) && review.dimensions.length > 0;
}

/**
 * 卡头文案：有维度表 = 分类器（System One）；没有 = 只跑了 decode-only 那一路。
 * backend 切到 chat 之后顶层 review 就是对话模型的结论，卡头不能写 System One。
 */
export function cardTitle(review) {
  return fromClassifier(review) ? "📊 System One 决策模型意见" : "🤖 LLM 审核（decode-only）";
}

/** 点卡头该摊开哪份原始提示词：跟着结论来源走 */
export function cardPromptKind(review) {
  return fromClassifier(review) ? "classifier" : "chat";
}

/**
 * 要不要显示「n/m 命中」那枚计数。
 *
 * 有维度表就显示（分类器跑过）；分类器本该跑却挂了（classifierFailed）也显示——
 * 那时候空表要如实说「寄了」。chat 单跑两者都没有，就不摆这枚计数。
 */
export function showWeightCount(review) {
  return fromClassifier(review) || Boolean(review?.classifierFailed);
}
