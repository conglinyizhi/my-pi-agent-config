// be-error-recorder.test.mjs — be-* 工具错误持久记录行为测试
//
// 背景：反馈模式下 worker 只允许 read/bash/be-* 工具（better-edit-tools 反馈收集）。
// be-* 调用失败时需要持久记录（模型使用错误），供用户离线审阅后手动编辑。
//
// 跑法：node --test extensions/be-error-recorder/be-error-recorder.test.mjs

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRecord, appendRecord } from "./index.ts";

describe("be-error-recorder", () => {
  const dir = mkdtempSync(join(tmpdir(), "beerr-"));
  const logPath = join(dir, "subagent-be-errors.jsonl");

  it("appends one JSON line for failed be-* tool", () => {
    appendRecord(logPath, buildRecord({
      toolName: "be-read", isError: true,
      input: { file: "/tmp/x.ts" },
      content: [{ type: "text", text: "boom" }],
    }, "task-1"));
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    assert.strictEqual(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.tool, "be-read");
    assert.strictEqual(rec.taskId, "task-1");
    assert(rec.error.includes("boom"));
  });

  it("ignores non-error and non-be-* results", () => {
    const before = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
    appendRecord(logPath, buildRecord({ toolName: "bash", isError: true, input: {}, content: [] }, "task-1"));
    appendRecord(logPath, buildRecord({ toolName: "be-read", isError: false, input: {}, content: [] }, "task-1"));
    assert.strictEqual(readFileSync(logPath, "utf-8"), before);
  });

  it("never rewrites existing lines (append-only, no dedup)", () => {
    const rec1 = buildRecord({ toolName: "be-write", isError: true, input: {}, content: [{ type: "text", text: "e1" }] }, "task-2");
    const rec2 = buildRecord({ toolName: "be-write", isError: true, input: {}, content: [{ type: "text", text: "e2" }] }, "task-2");
    appendRecord(logPath, rec1);
    appendRecord(logPath, rec2);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    assert.strictEqual(lines.length, 3); // 之前 1 条 + 新增 2 条，不去重不清理
  });

  rmSync(dir, { recursive: true, force: true });
});
