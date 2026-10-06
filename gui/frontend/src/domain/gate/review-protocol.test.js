// review-protocol.test.js — 审核协议展示逻辑的用例
// 跑法：node --test gui/frontend/src/domain/gate/review-protocol.test.js

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  budgetLabel,
  cardPromptKind,
  cardTitle,
  fromClassifier,
  reasonText,
  showWeightCount,
} from "./review-protocol.js";

describe("budgetLabel", () => {
  it("20 档写成 <20 字，其余写数字", () => {
    assert.equal(budgetLabel(20), "<20 字");
    assert.equal(budgetLabel(40), "40 字");
    assert.equal(budgetLabel(60), "60 字");
  });
  it("缺值 / 未知值 → 空串（不摆一行空的档位）", () => {
    assert.equal(budgetLabel(undefined), "");
    assert.equal(budgetLabel(0), "");
    assert.equal(budgetLabel("60"), "");
  });
});

describe("reasonText", () => {
  it("有理由就用理由", () => {
    assert.equal(reasonText({ verdict: "risky", reason: "路径含通配符" }), "路径含通配符");
  });
  it("判可行且没有理由 → 露出 [ok]", () => {
    assert.equal(reasonText({ verdict: "safe", reason: "" }), "[ok]");
  });
  it("非可行且没有理由 → 空串（失败另有失败文案，别写成 ok）", () => {
    assert.equal(reasonText({ verdict: "error", reason: "" }), "");
    assert.equal(reasonText(undefined), "");
  });
});

describe("卡头与计数：跟着结论来源走", () => {
  const classifierReview = { verdict: "risky", dimensions: [{ key: "intent" }] };
  const chatReview = { verdict: "risky", reason: "路径含通配符", riskBudget: 40 };

  it("有维度表 → 分类器卡，点开分类器提示词", () => {
    assert.equal(fromClassifier(classifierReview), true);
    assert.ok(cardTitle(classifierReview).includes("System One"));
    assert.equal(cardPromptKind(classifierReview), "classifier");
    assert.equal(showWeightCount(classifierReview), true);
  });

  it("没有维度表 → decode-only 卡，点开 chat 提示词，不摆计数", () => {
    assert.equal(fromClassifier(chatReview), false);
    assert.ok(cardTitle(chatReview).includes("decode-only"));
    assert.equal(cardPromptKind(chatReview), "chat");
    assert.equal(showWeightCount(chatReview), false);
  });

  it("分类器本该跑却挂了（classifierFailed）→ 计数照摆，好让空表说「寄了」", () => {
    const failed = { verdict: "error", reason: "分类器失败", classifierFailed: "无 key" };
    assert.equal(showWeightCount(failed), true);
    assert.equal(cardPromptKind(failed), "chat");
  });
});
