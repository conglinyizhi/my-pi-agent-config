// deepseek-search — DeepSeek 服务端 web_search 接入
//
// 通过 DeepSeek Responses API 的服务端内置 web_search 工具实现联网搜索：
// 搜索由 DeepSeek 服务器执行，本扩展只负责把 query 送过去、取回搜索结果文本。
// API key 从 ~/.pi/agent/auth.json 的 deepseek.key 读取（gitignore，不入库）。
//
// 参考：https://api-docs.deepseek.com/zh-cn/guides/responses_api/

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");
const BASE_URL = "https://api.deepseek.com/responses";
const DEFAULT_MODEL = "deepseek-v4-flash";

/** 从 auth.json 读 deepseek key（gitignore，不入库；缺失返回空串） */
export function getDeepSeekKey(): string {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
    return auth?.deepseek?.key || "";
  } catch {
    return "";
  }
}

export interface SearchResult {
  text: string;
  webSearchCalls: number;
}

/** 调 DeepSeek Responses API + web_search，返回搜索后回答文本 */
export async function deepseekWebSearch(query: string, key: string, model = DEFAULT_MODEL): Promise<SearchResult> {
  const body = JSON.stringify({
    model,
    input: query,
    tools: [{ type: "web_search" }],
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
    const errText = await resp.text();
    throw new Error(`DeepSeek search API ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };
  const outputs = data.output ?? [];
  const webSearchCalls = outputs.filter((o) => o.type === "web_search_call").length;
  const texts: string[] = [];
  for (const o of outputs) {
    if (o.type === "message") {
      for (const c of o.content ?? []) {
        if (c.type === "output_text" && c.text) texts.push(c.text);
      }
    }
  }
  return { text: texts.join("\n\n"), webSearchCalls };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "通过 DeepSeek 服务端联网搜索获取最新信息。搜索在服务端执行，返回带来源的搜索结果文本。用于需要实时信息、新闻、文档、代码示例的场景。",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "web_search 用于获取模型知识截止之后的信息：新闻、实时状态、最新文档、他人公开代码。",
      "提问要具体：把搜索意图写清楚（如「DeepSeek Responses API web_search 工具用法」而不是「DeepSeek」）。",
      "搜索结果是服务端实时抓取的，可能包含来源链接与摘要；引用时注意甄别时效性。",
      "需要多个独立主题时，可以多次调用，每次一个 query。",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "搜索查询，具体且包含上下文" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const key = getDeepSeekKey();
      if (!key) {
        return {
          content: [{ type: "text", text: "错误：auth.json 中未配置 deepseek key。请先配置：pi auth 或编辑 ~/.pi/agent/auth.json" }],
          details: { error: "no_deepseek_key" },
        };
      }
      try {
        const { text, webSearchCalls } = await deepseekWebSearch(params.query, key);
        if (!text) {
          return {
            content: [{ type: "text", text: "搜索完成但没有返回文本结果（服务端可能未找到相关结果）。" }],
            details: { webSearchCalls },
          };
        }
        return {
          content: [{ type: "text", text }],
          details: { webSearchCalls },
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
