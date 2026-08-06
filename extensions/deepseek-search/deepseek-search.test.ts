// deepseek-search.test.ts — 搜索接入行为测试
//
// 覆盖：key 读取、Responses API 响应解析（mock）、无结果/失败路径。
// 真实 API 调用放 e2e（手动验证），单测用 mock 数据保证确定性。
//
// 跑法：node --experimental-strip-types extensions/deepseek-search/deepseek-search.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { getDeepSeekKey, deepseekWebSearch, formatSources, type SearchResult } from "./index.ts";

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

  it("提取 open_page 轨迹作为引用来源", async () => {
    const restore = mockFetchOnce({
      output: [
        { type: "web_search_call", status: "completed", action: { type: "search", queries: ["pnpm latest"] } },
        { type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://pnpm.io/blog/releases/11.20#ws_call_id=call_01" } },
        { type: "web_search_call", status: "failed", action: { type: "open_page", url: "https://github.com/pnpm/pnpm/releases#ws_call_id=call_02" } },
        { type: "message", content: [{ type: "output_text", text: "pnpm 11.20 已发布。" }] },
      ],
    });
    try {
      const r = await deepseekWebSearch("pnpm 最新版本", "test-key");
      assert.strictEqual(r.text, "pnpm 11.20 已发布。");
      assert.deepStrictEqual(r.sources, [
        { url: "https://pnpm.io/blog/releases/11.20", status: "completed" },
        { url: "https://github.com/pnpm/pnpm/releases", status: "failed" },
      ]);
    } finally {
      restore();
    }
  });

  it("无 open_page 时来源为空", async () => {
    const restore = mockFetchOnce({
      output: [
        { type: "web_search_call", status: "completed", action: { type: "search", queries: ["x"] } },
        { type: "message", content: [{ type: "output_text", text: "结果" }] },
      ],
    });
    try {
      const r = await deepseekWebSearch("x", "test-key");
      assert.deepStrictEqual(r.sources, []);
    } finally {
      restore();
    }
  });

  it("formatSources 生成来源清单文本", () => {
    const t = formatSources([
      { url: "https://pnpm.io/blog/releases/11.20", status: "completed" },
      { url: "https://github.com/pnpm/pnpm/releases", status: "failed" },
    ]);
    assert(t.includes("引用来源"));
    assert(t.includes("https://pnpm.io/blog/releases/11.20 (已访问)"));
    assert(t.includes("https://github.com/pnpm/pnpm/releases (访问失败)"));
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
