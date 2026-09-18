import test from "node:test";
import assert from "node:assert/strict";
import { formatReturnLine, formatUnclaimedReturn } from "./return-notice.ts";
import type { BatchItemResult } from "./batch.ts";

function result(overrides: Partial<BatchItemResult> = {}): BatchItemResult {
  return { index: 0, status: "success", output: "干完了", stderr: "", ...overrides };
}

test("正常返航：带批次号与每个 worker 的简报", () => {
  const text = formatUnclaimedReturn("batch-abc", [
    result({ index: 0, output: "实际等待：45 秒" }),
    result({ index: 1, status: "failed", output: "", errorMessage: "炸了" }),
  ]);
  assert.match(text, /batch-abc/);
  assert.match(text, /#1 SUCCESS/);
  assert.match(text, /实际等待：45 秒/);
  assert.match(text, /#2 FAILED error=炸了/);
});

test("没有结果时给出可执行的下一步，而不是空白消息", () => {
  const text = formatUnclaimedReturn("batch-x", []);
  assert.match(text, /异常结束/);
  assert.match(text, /\/subagent:gui/);
});

test("超长输出被截断，不让一条通知撑爆上下文", () => {
  const line = formatReturnLine(result({ output: "字".repeat(5000) }));
  assert.ok(line.length < 1000, `长度 ${line.length} 应该被截断`);
});

test("错误信息也截断，保留前 200 字符够定位", () => {
  const line = formatReturnLine(result({ status: "failed", errorMessage: "错".repeat(500), output: "" }));
  assert.ok(line.length < 500);
  assert.match(line, /FAILED error=/);
});
