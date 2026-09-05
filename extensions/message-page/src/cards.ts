import { randomUUID } from "node:crypto";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type DecisionPriority = "high" | "medium" | "low";

export interface Decision {
  priority: DecisionPriority;
  question: string;
  options: string[];
  recommendation: string;
  reasoning: string;
  /** 可选：该决策在原文中对应的原句/片段，用于网页里锚点高亮定位 */
  source?: string;
  /** “我无法决策”：选中该选项时展开的详细说明。要求大段落而非小段落 */
  cannotDecide?: string;
}

export interface CardResult {
  title?: string;
  summary?: string;
  decisions: Decision[];
}

/** 贪心但安全地解析模型返回的 JSON：去掉 ```fence、截取首尾花括号、容错空数组。 */
export function parseCardJson(raw: string): CardResult {
  let text = raw.trim();

  // 去掉可能的 ```json ... ``` 围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  // 截取第一个 { 到最后一个 }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }

  try {
    const obj = JSON.parse(text);
    const decisions = Array.isArray(obj.decisions)
      ? obj.decisions
          .filter((d: unknown): d is Record<string, unknown> => !!d && typeof d === "object")
          .map(normalizeDecision)
          .filter((d: Decision | null): d is Decision => !!d)
      : [];
    return {
      title: typeof obj.title === "string" ? obj.title : undefined,
      summary: typeof obj.summary === "string" ? obj.summary : undefined,
      decisions,
    };
  } catch {
    // 解析彻底失败：退化为一条"原始文本"卡片，不丢信息
    return { decisions: [] };
  }
}

function normalizeDecision(raw: Record<string, unknown>): Decision | null {
  if (typeof raw.question !== "string" || !raw.question.trim()) {
    return null;
  }
  const priority: DecisionPriority =
    raw.priority === "high" || raw.priority === "medium" || raw.priority === "low"
      ? raw.priority
      : "medium";
  const options = Array.isArray(raw.options)
    ? raw.options.filter((o): o is string => typeof o === "string").slice(0, 6)
    : [];
  const source =
    typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : undefined;
  const cannotDecide =
    typeof raw.cannotDecide === "string" && raw.cannotDecide.trim()
      ? raw.cannotDecide.trim()
      : undefined;
  return {
    priority,
    question: raw.question,
    options,
    recommendation: typeof raw.recommendation === "string" ? raw.recommendation : "",
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
    source,
    cannotDecide,
  };
}

function buildPrompt(md: string): string {
  return [
    "下面是技术对话中最后一条 AI 助手回复的 Markdown 原文。",
    "任务：仅提取这条消息里【需要用户拍板决定的问题】，例如需要用户选择/确认/批准/权衡的决策点。",
    "不要总结全文，不要列待办，不要提没有真正要求用户决定的内容。",
    "如果消息里没有任何需要用户决策的点，返回 {\"decisions\": []}。",
    "",
    "只返回一个 JSON 对象，禁止 markdown 围栏、禁止任何解释文字。JSON 结构：",
    "{",
    '  "title": "整条消息的简短标题（给页面用）",',
    '  "summary": "一句中文概览：这条消息在说什么",',
    '  "decisions": [',
    "    {",
    '      "priority": "high" | "medium" | "low",',
    '      "question": "需要拍板的问题（一句话）",',
    '      "options": ["选项1", "选项2"],   // 2~4 个；如果只是开放问题可留空数组',
    '      "recommendation": "建议选哪个（若消息里有倾向；没有则留空字符串）",',
    '      "reasoning": "简短理由（中文）",',
    '      "source": "可选：原文中与之对应的原句，尽量原样引用，用于网页锚点高亮定位",',
    '      "cannotDecide": "可选：当用户可能选“我无法决策”时，写一段详细说明（为什么暂时难以拍板、还缺什么信息、有什么权衡）",',
    "    }",
    "  ]",
    "}",
    "",
    "规则：question/options/recommendation/reasoning 用中文写，简洁；priority 反映这条决策的紧迫或重要程度。",
    "cannotDecide 要用大段落（1~3 段连贯文字）而不是逐条小段落或列表来写，以节省页面纵向空间；只有消息里确实体现出用户可能缺少信息才能决定时，才提供该字段，否则省略。",
    "",
    "<message>",
    md,
    "</message>",
  ].join("\n");
}

/**
 * 用指定模型分析最后一条 AI 消息，提炼决策卡片。
 * 模型无认证或调用失败时抛出 Error，由调用方兜底。
 */
export async function extractDecisions(
  ctx: ExtensionContext,
  model: Model<Api>,
  md: string,
  signal?: AbortSignal,
): Promise<CardResult> {
  const prompt = buildPrompt(md.slice(0, 60_000));

  // 解析该模型的认证信息（API key / headers / env），供 compat.complete 使用。
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error || "模型认证不可用");
  }
  if (!auth.apiKey) {
    throw new Error("该模型没有可用的 API key");
  }

  const response = await complete(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      cacheRetention: "none",
      sessionId: randomUUID(),
      signal,
    },
  );

  const raw = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  return parseCardJson(raw);
}
