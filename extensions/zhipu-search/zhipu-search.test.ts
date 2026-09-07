// zhipu-search.test.ts — 智谱 Web Search 接入行为测试
//
// 覆盖：key 读取、Web Search API 响应解析（mock）、格式化、无结果/失败路径。
// 真实 API 调用放 e2e（手动验证），单测用 mock 数据保证确定性。
//
// 跑法：node --experimental-strip-types extensions/zhipu-search/zhipu-search.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import {
  getZhipuKey,
  zhipuWebSearch,
  formatSearchResults,
  formatIntent,
  type SearchResultItem,
} from "./index.ts";

// mock fetch：拦截 zhipuWebSearch 里的 fetch 调用
function mockFetchOnce(data: unknown, ok = true, status = 200) {
  const g = globalThis as Record<string, unknown>;
  const orig = g.fetch;
  g.fetch = (async () => ({
    ok,
    status,
    text: async () => (ok ? "" : "mock error body"),
    json: async () => data,
  })) as unknown as typeof fetch;
  return () => {
    g.fetch = orig;
  };
}

// 智谱标准响应用例
const sampleResponse = {
  id: "task_123",
  created: 1720000000,
  request_id: "req-abc123",
  search_intent: [
    { query: "pnpm latest", intent: "SEARCH_ALL", keywords: "pnpm 最新版本" },
  ],
  search_result: [
    {
      title: "pnpm 11.20 发布",
      content: "pnpm 11.20 已发布，包含若干改进。",
      link: "https://pnpm.io/blog/releases/11.20",
      media: "pnpm",
      icon: "https://pnpm.io/favicon.ico",
      refer: "1",
      publish_date: "2026-08-06",
    },
    {
      title: "pnpm releases",
      content: "GitHub 上的发布页面。",
      link: "https://github.com/pnpm/pnpm/releases",
      media: "GitHub",
      icon: "",
      refer: "2",
      publish_date: "",
    },
  ],
};

describe("zhipu-search", () => {
  it("auth.json 中有 zhipu key", () => {
    const key = getZhipuKey();
    assert(typeof key === "string" && key.length > 0, "本机 auth.json 应配置 zhipu key");
  });

  it("解析智谱 Web Search 响应：提取 search_result 与 search_intent", async () => {
    const restore = mockFetchOnce(sampleResponse);
    try {
      const r = await zhipuWebSearch("pnpm latest", "test-key");
      assert.strictEqual(r.search_result.length, 2);
      assert.strictEqual(r.search_result[0].title, "pnpm 11.20 发布");
      assert.strictEqual(r.search_result[0].link, "https://pnpm.io/blog/releases/11.20");
      assert.strictEqual(r.search_intent[0].intent, "SEARCH_ALL");
      assert.strictEqual(r.request_id, "req-abc123");
    } finally {
      restore();
    }
  });

  it("请求体：search_intent 固定为 false，可选参数生效", async () => {
    let sentBody = "";
    const g = globalThis as Record<string, unknown>;
    const orig = g.fetch;
    g.fetch = (async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ search_result: [] }),
      };
    }) as unknown as typeof fetch;
    try {
      await zhipuWebSearch("查询", "test-key", {
        search_engine: "search_pro",
        count: 20,
        search_recency_filter: "oneWeek",
        content_size: "high",
      });
      const body = JSON.parse(sentBody);
      assert.strictEqual(body.search_engine, "search_pro");
      assert.strictEqual(body.search_intent, false);
      assert.strictEqual(body.count, 20);
      assert.strictEqual(body.search_recency_filter, "oneWeek");
      assert.strictEqual(body.content_size, "high");
    } finally {
      g.fetch = orig;
    }
  });

  it("无 search_result 时返回空数组不抛错", async () => {
    const restore = mockFetchOnce({ search_result: [] });
    try {
      const r = await zhipuWebSearch("查询", "test-key");
      assert.deepStrictEqual(r.search_result, []);
    } finally {
      restore();
    }
  });

  it("formatSearchResults 生成结构化文本", () => {
    const t = formatSearchResults(
      [
        { title: "标题A", content: "摘要A", link: "https://a.com", media: "站点A", icon: "", refer: "1", publish_date: "2026-08-01" },
        { title: "", content: "无标题", link: "https://b.com", media: "", icon: "", refer: "2", publish_date: "" },
      ],
      "search_std",
    );
    assert(t.includes("搜索引擎：search_std"));
    assert(t.includes("标题A"));
    assert(t.includes("https://a.com"));
    assert(t.includes("来源：站点A"));
    assert(t.includes("(无标题)"));
  });

  it("formatIntent 生成意图说明文本", () => {
    const t = formatIntent([
      { query: "pnpm latest", intent: "SEARCH_ALL", keywords: "pnpm 最新版本" },
      { query: "x", intent: "SEARCH_NONE", keywords: "" },
    ]);
    assert(t.includes("搜索意图"));
    assert(t.includes("SEARCH_ALL"));
    assert(t.includes("pnpm 最新版本"));
  });

  it("API 非 2xx 抛错带状态码", async () => {
    const restore = mockFetchOnce({ error: { code: "1703", message: "搜索引擎未返回有效数据" } }, false, 500);
    try {
      await assert.rejects(() => zhipuWebSearch("查询", "bad-key"), /500/);
    } finally {
      restore();
    }
  });

  it("缺 key 抛错", async () => {
    await assert.rejects(() => zhipuWebSearch("查询", ""), /缺少智谱 API key/);
  });
});
