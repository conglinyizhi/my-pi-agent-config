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

/** 模型对“是否真的有决策内容”的判定结果：要么有卡片，要么无需决策（带理由）。 */
export type DecisionCheck =
  | { hasDecision: true; cards: CardResult }
  | { hasDecision: false; reason: string };

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

/**
 * 解析模型返回，判定是否真的需要决策。
 * - 工具调用形式：{"tool":"no_decision","args":{"reason":"..."}} → 无需决策
 * - 严格 JSON：{"hasDecision":false,"reason":"..."} → 无需决策
 * - 其它（含 decisions 或 hasDecision true）→ 有决策，解析卡片
 * - 完全解析不出来 → 保守当作有决策（不丢信息，走原有 fallback）
 */
export function parseDecisionCheck(raw: string): DecisionCheck {
  let text = raw.trim();

  // 去掉 ```json fence
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  // 截取第一个 { 到最后一个 }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }

  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    // 无法解析出明确结果 → 保守按有决策处理
    return { hasDecision: true, cards: { decisions: [] } };
  }

  if (!obj || typeof obj !== "object") {
    return { hasDecision: true, cards: { decisions: [] } };
  }
  const o = obj as Record<string, unknown>;

  // 工具调用形式：no_decision 带 reason
  if (o.tool === "no_decision") {
    const args = (o.args ?? {}) as Record<string, unknown>;
    const reason =
      typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim()
        : "该消息无需用户决策";
    return { hasDecision: false, reason };
  }

  // 严格 JSON：hasDecision 为 false
  if (o.hasDecision === false) {
    const reason =
      typeof o.reason === "string" && o.reason.trim()
        ? o.reason.trim()
        : "该消息无需用户决策";
    return { hasDecision: false, reason };
  }

  // 有决策：解析卡片
  const decisions = Array.isArray(o.decisions)
    ? o.decisions
        .filter((d: unknown): d is Record<string, unknown> => !!d && typeof d === "object")
        .map(normalizeDecision)
        .filter((d: Decision | null): d is Decision => !!d)
    : [];
  return {
    hasDecision: true,
    cards: {
      title: typeof o.title === "string" ? o.title : undefined,
      summary: typeof o.summary === "string" ? o.summary : undefined,
      decisions,
    },
  };
}

/** 兼容旧调用：返回决策卡片。无决策或解析失败时返回空 decisions。 */
export function parseCardJson(raw: string): CardResult {
  const result = parseDecisionCheck(raw);
  return result.hasDecision ? result.cards : { decisions: [] };
}

function buildPrompt(md: string): string {
  return [
    "下面是技术对话中最后一条 AI 助手回复的 Markdown 原文。",
    "任务：先判断这条消息里是否真的有【需要用户拍板决定的问题】（例如需要用户选择/确认/批准/权衡）。",
    "不要总结全文，不要列待办，不要提没有真正要求用户决定的内容。",
    "",
    "若【没有任何内容需要用户决策】（例如这只是一条通知/状态更新/纯陈述），请调用工具 no_decision 来报告：",
    '  no_decision 的参数：reason 字符串，说明为什么不需要用户决策（例如：这只是一条完成通知）',
    '  工具调用形式：{"tool": "no_decision", "args": {"reason": "..."}}',
    '  若你所在的环境不支持调用工具，则直接返回严格 JSON：{"hasDecision": false, "reason": "..."}',
    "",
    "若【确实有需要用户决策的内容】，请返回如下 JSON（禁止 markdown 围栏、禁止任何解释文字）：",
    "{",
    '  "hasDecision": true,',
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
 * 用指定模型分析最后一条 AI 消息，判定是否需要决策并提炼卡片。
 * 模型无认证或调用失败时抛出 Error，由调用方兜底。
 */
export async function extractDecisions(
  ctx: ExtensionContext,
  model: Model<Api>,
  md: string,
  signal?: AbortSignal,
): Promise<DecisionCheck> {
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

  return parseDecisionCheck(raw);
}
