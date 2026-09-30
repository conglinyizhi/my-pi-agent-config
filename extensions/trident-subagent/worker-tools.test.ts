// worker-tools.test.ts — worker 工具白名单构造行为测试
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/worker-tools.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { buildSafeWorkerTools } from "./worker-tools.ts";

const BE_READ = "mcp__better-edit-tools__be-read";
const BE_WRITE = "mcp__better-edit-tools__be-write";

describe("worker tools", () => {
  it("普通 worker 保留文件/bash/MCP 的 be-*/web_search，排除编排与派发工具", () => {
    const tools = buildSafeWorkerTools([
      "read", "write", "edit", "bash", "grep", "find", "ls",
      BE_READ, BE_WRITE, "web_search", "codemode", "tool_search", "subagent",
    ]);
    assert.deepStrictEqual(tools, [
      "bash", "edit", "find", "grep", "ls", BE_READ, BE_WRITE, "read", "web_search", "write",
    ]);
  });

  it("后台任务工具 bash_background / job_output 下发（长任务不必同步空等）", () => {
    const tools = buildSafeWorkerTools([
      "read", "bash", "bash_background", "job_output",
    ]);
    assert.ok(tools.includes("bash_background"), "bash_background 在 worker 工具名单里");
    assert.ok(tools.includes("job_output"), "job_output 在 worker 工具名单里");
    assert.deepStrictEqual(tools, ["bash", "bash_background", "job_output", "read"]);
  });

  it("后台任务的列表/中止工具不下发（job_list / job_kill 不进白名单）", () => {
    const tools = buildSafeWorkerTools([
      "bash_background", "job_output", "job_list", "job_kill",
    ]);
    assert.deepStrictEqual(tools, ["bash_background", "job_output"]);
  });

  it("别的 MCP 的非 be-* 工具不下发，旧的无前缀 be-* 名字也不认", () => {
    const tools = buildSafeWorkerTools([
      "read", "bash", "be-read", "mcp__better-edit-tools__list_store", "mcp__other-server__list_store",
    ]);
    assert.deepStrictEqual(tools, ["bash", "read"]);
  });
});
