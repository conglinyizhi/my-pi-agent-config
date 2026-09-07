// zhipu-search — 智谱 BigModel Web Search 接入
//
// 通过智谱(大模型) Web Search API 实现联网搜索：
// 调用 POST https://open.bigmodel.cn/api/paas/v4/web_search，返回结构化搜索结果列表。
// 本扩展只负责把 query 送过去、取回 search_result[] 原始条目，不做任何模型总结。
// API key 从 ~/.pi/agent/auth.json 的 zhipu.key 读取（gitignore，不入库）。
//
// 参考：https://docs.bigmodel.cn/api-reference/工具-api/网络搜索

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");
const BASE_URL = "https://open.bigmodel.cn/api/paas/v4/web_search";

/** 智谱支持的搜索引擎编码 */
export const SEARCH_ENGINES = ["search_std", "search_pro", "search_pro_sogou", "search_pro_quark"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

/** 搜索时间范围 */
export const RECENCY_FILTERS = ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"] as const;
export type RecencyFilter = (typeof RECENCY_FILTERS)[number];

/** 返回内容长短 */
export const CONTENT_SIZES = ["medium", "high"] as const;
export type ContentSize = (typeof CONTENT_SIZES)[number];

/** 从 auth.json 读智谱 key（gitignore，不入库；缺失返回空串） */
export function getZhipuKey(): string {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
    return auth?.zhipu?.key || "";
  } catch {
    return "";
  }
}

export interface SearchResultItem {
  title: string;
  content: string;
  link: string;
  media: string;
  icon: string;
  refer: string;
  publish_date: string;
}

export interface SearchIntentItem {
  query: string;
  intent: string;
  keywords: string;
}

export interface WebSearchResult {
  request_id: string;
  id: string;
  created: number;
  search_intent: SearchIntentItem[];
  search_result: SearchResultItem[];
}

/** 把搜索结果的原始条目格式化为文本段（供返回 content） */
export function formatSearchResults(result: SearchResultItem[], engine: string): string {
  if (result.length === 0) return "";
  const lines = result.map((r, i) => {
    const meta = [
      r.media ? `来源：${r.media}` : "",
      r.publish_date ? `时间：${r.publish_date}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
    return [
      `${i + 1}. ${r.title || "(无标题)"}`,
      `   摘要：${r.content || "(无摘要)"}`,
      `   链接：${r.link}`,
      meta ? `   ${meta}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `搜索完成（搜索引擎：${engine}，共 ${result.length} 条）：\n\n${lines.join("\n")}`;
}

/** 把搜索意图识别结果格式化为文本（供说明） */
export function formatIntent(intentList: SearchIntentItem[]): string {
  if (intentList.length === 0) return "";
  const lines = intentList.map((it) => {
    const s = [`原始query：${it.query}`, `意图：${it.intent}`];
    if (it.keywords) s.push(`关键词：${it.keywords}`);
    return `- ${s.join("，")}`;
  });
  return `搜索意图：\n${lines.join("\n")}`;
}

export interface WebSearchOptions {
  search_engine?: SearchEngine;
  count?: number;
  search_recency_filter?: RecencyFilter;
  content_size?: ContentSize;
}

/** 调智谱 Web Search API，返回结构化搜索结果 */
export async function zhipuWebSearch(
  query: string,
  key: string,
  opts: WebSearchOptions = {},
): Promise<WebSearchResult> {
  if (!key) throw new Error("缺少智谱 API key");
  const body = JSON.stringify({
    search_query: query,
    search_engine: opts.search_engine ?? "search_std",
    search_intent: false,
    ...(opts.count != null ? { count: opts.count } : {}),
    ...(opts.search_recency_filter ? { search_recency_filter: opts.search_recency_filter } : {}),
    ...(opts.content_size ? { content_size: opts.content_size } : {}),
  });
  const resp = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body,
  });
  if (!resp.ok) {
    let detail = "";
    try {
      const err = (await resp.json()) as { error?: { code?: string; message?: string } };
      detail = err?.error ? `code=${err.error.code} message=${err.error.message}` : await resp.text();
    } catch {
      detail = await resp.text();
    }
    throw new Error(`智谱搜索 API ${resp.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await resp.json()) as WebSearchResult;
  return data;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "联网搜索(结构化)：调用智谱 Web Search API，返回原始搜索结果条目列表(标题/摘要/链接/来源/时间)。不做代理式总结——调用方(模型)需自行综合多个结果。用于获取模型知识截止之后的信息：新闻、实时状态、最新文档、他人公开代码。",
    promptSnippet: "Search the web and return structured results",
    promptGuidelines: [
      "web_search 是结构化搜索：一次 query 一次搜索，返回 search_result[] 原始条目列表(标题/摘要/链接/来源/时间)，不是模型总结。",
      "用于获取模型知识截止之后的信息：新闻、实时状态、最新文档、他人公开代码。",
      "search_query 上限 70 个字符；搜索词要具体且包含上下文(如「DeepSeek Responses API web_search 工具用法」而不是「DeepSeek」)。",
      "需要多个主题时多次调用，每次一个 search_query。返回是原始结果，需要结论时由调用方综合多个条目。",
      "可通过 search_engine 切换引擎(search_std=智谱基础版 / search_pro=智谱高阶 / search_pro_sogou=搜狗 / search_pro_quark=夸克)；count 控制条数(1-50)；search_recency_filter 限定时间范围；content_size 控制摘要长短。",
      "部分引擎对 count 有限制(如 search_pro_sogou 仅支持 10/20/30/40/50)，不生效时按实际返回为准。",
    ],
    parameters: Type.Object({
      search_query: Type.String({ description: "搜索内容，建议不超过 70 个字符，尽量具体含上下文" }),
      search_engine: Type.Optional(
        Type.Union(
          SEARCH_ENGINES.map((e) => Type.Literal(e)),
          { description: "搜索引擎：search_std(基础)/search_pro(高阶)/search_pro_sogou(搜狗)/search_pro_quark(夸克)。默认 search_std" },
        ),
      ),
      count: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: "返回条数，1-50，默认 10" }),
      ),
      search_recency_filter: Type.Optional(
        Type.Union(
          RECENCY_FILTERS.map((r) => Type.Literal(r)),
          { description: "时间范围：oneDay/oneWeek/oneMonth/oneYear/noLimit，默认 noLimit" },
        ),
      ),
      content_size: Type.Optional(
        Type.Union(
          CONTENT_SIZES.map((c) => Type.Literal(c)),
          { description: "摘要长度：medium(常规)/high(详细，信息量大)，默认 medium" },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const key = getZhipuKey();
      if (!key) {
        return {
          content: [{ type: "text", text: "错误：auth.json 中未配置 zhipu key。请先配置：编辑 ~/.pi/agent/auth.json 的 zhipu.key" }],
          details: { error: "no_zhipu_key" },
        };
      }
      try {
        const result = await zhipuWebSearch(params.search_query, key, {
          search_engine: params.search_engine,
          count: params.count,
          search_recency_filter: params.search_recency_filter,
          content_size: params.content_size,
        });
        const items = result.search_result ?? [];
        if (items.length === 0) {
          return {
            content: [{ type: "text", text: "搜索完成但没有返回结果（可能无匹配，或引擎不支持当前参数）。" }],
            details: { request_id: result.request_id },
          };
        }
        const intentText = formatIntent(result.search_intent ?? []);
        const body = formatSearchResults(items, params.search_engine ?? "search_std");
        const text = intentText ? `${intentText}\n\n${body}` : body;
        return {
          content: [{ type: "text", text }],
          details: {
            request_id: result.request_id,
            id: result.id,
            created: result.created,
            search_intent: result.search_intent ?? [],
            search_result: items,
            search_engine: params.search_engine ?? "search_std",
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `搜索失败：${String(err)}` }],
          details: { error: String(err) },
        };
      }
    },
  });
}
