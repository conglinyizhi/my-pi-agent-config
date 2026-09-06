import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeWorkerBrief } from "./subagent-brief.ts";

describe("normalizeWorkerBrief", () => {
  it("keeps legacy string tasks compatible", () => {
    assert.deepEqual(normalizeWorkerBrief("调查当前实现", ["which-pi-docs"]), {
      task: "调查当前实现",
      skills: ["which-pi-docs"],
    });
  });

  it("includes context, constraints, required files, acceptance and output format", () => {
    const result = normalizeWorkerBrief({
      objective: "修复状态竞态",
      context: "当前状态由单一快照文件提供",
      constraints: ["不要改动 GUI 协议"],
      required_files: ["lib/status-bus.ts", "extensions/trident-subagent/status.ts"],
      skills: ["which-pi-docs"],
      acceptance: ["补充并通过竞态测试"],
      output_format: "按结论、改动、测试、风险回报",
    });
    assert.match(result.task, /任务目标\n修复状态竞态/);
    assert.match(result.task, /必要上下文\n当前状态由单一快照文件提供/);
    assert.match(result.task, /必看文件 \/ 目录\n- lib\/status-bus\.ts/);
    assert.match(result.task, /验收标准\n- 补充并通过竞态测试/);
    assert.match(result.task, /输出格式\n按结论、改动、测试、风险回报/);
    assert.deepEqual(result.skills, ["which-pi-docs"]);
  });

  it("merges and deduplicates inherited and per-worker skills", () => {
    const result = normalizeWorkerBrief({
      objective: "调查",
      skills: ["moonbit-orientation", "which-pi-docs", "moonbit-orientation"],
    }, ["which-pi-docs"]);
    assert.deepEqual(result.skills, ["which-pi-docs", "moonbit-orientation"]);
  });

  it("rejects an empty structured objective", () => {
    assert.throws(() => normalizeWorkerBrief({ objective: "  " }), /non-empty objective/);
  });
});
