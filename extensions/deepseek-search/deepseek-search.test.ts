// deepseek-search.test.ts — 搜索接入行为测试
//
// 覆盖：key 读取、Responses API 响应解析（mock）、无结果/失败路径。
// 真实 API 调用放 e2e（手动验证），单测用 mock 数据保证确定性。
//
// 跑法：node --experimental-strip-types extensions/deepseek-search/deepseek-search.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { getDeepSeekKey, deepseekWebSearch, type SearchResult } from "./index.ts";

// mock fetch：拦截 deepseekWebSearch 里的 fetch 调用
function mockFetchOnce(data: unknown, ok = true, status = 200) {
  const g = globalThis as Record<string, unknown>;
  const orig = g.fetch;
  g.fetch = (async () => ({
    ok,
    status,
    text: async () => (ok ? "" : "mock error body"),
    json: async () => data,
  })) as unknown as typeof fetch;
  return () => { g.fetch = orig; };
}

describe("deepseek-search", () => {
  it("auth.json 中有 deepseek key", () => {
    const key = getDeepSeekKey();
    assert(typeof key === "string" && key.length > 0, "本机 auth.json 应配置 deepseek key");
  });

  it("解析 Responses API 输出：提取 message 的 output_text", async () => {
    const restore = mockFetchOnce({
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "思考" }] },
        { type: "web_search_call", id: "s1" },
        { type: "message", content: [{ type: "output_text", text: "搜索结果：今天是 2026 年 8 月 6 日。" }] },
      ],
    });
    try {
      const r = await deepseekWebSearch("今天几号", "test-key");
      assert.strictEqual(r.text, "搜索结果：今天是 2026 年 8 月 6 日。");
      assert.strictEqual(r.webSearchCalls, 1);
    } finally {
      restore();
    }
  });

  it("无 message 输出时返回空文本但统计搜索调用", async () => {
    const restore = mockFetchOnce({ output: [{ type: "web_search_call", id: "s1" }] });
    try {
      const r: SearchResult = await deepseekWebSearch("查询", "test-key");
      assert.strictEqual(r.text, "");
      assert.strictEqual(r.webSearchCalls, 1);
    } finally {
      restore();
    }
  });

  it("API 非 2xx 抛错带状态码", async () => {
    const restore = mockFetchOnce({ error: "boom" }, false, 401);
    try {
      await assert.rejects(() => deepseekWebSearch("查询", "bad-key"), /401/);
    } finally {
      restore();
    }
  });
});
