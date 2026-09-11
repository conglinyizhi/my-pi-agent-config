// worker-tools.test.ts — worker 工具白名单构造行为测试
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/worker-tools.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { buildSafeWorkerTools } from "./worker-tools.ts";

describe("worker tools", () => {
  it("普通 worker 只保留文件/bash/be-*，排除联网与 MCP 工具", () => {
    const tools = buildSafeWorkerTools([
      "read", "write", "edit", "bash", "grep", "find", "ls",
      "be-read", "web_search", "mcp", "mcpScript", "subagent",
    ]);
    assert.deepStrictEqual(tools, ["bash", "be-read", "edit", "find", "grep", "ls", "read", "write"]);
  });
});
