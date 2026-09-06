import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { markdownToHtml } from "./src/markdown.ts";
import { extractDecisions, type DecisionCheck } from "./src/cards.ts";
import { pickModel, resolveModel, writeLastModel } from "../../lib/model-selection.ts";
import { renderPage, splitMarkdownByHeadings, templateNames, type PageData, type TemplateName } from "./src/templates.ts";
import { openInBrowser } from "./src/open.ts";

const OUTPUT_DIR = join(homedir(), ".pi", "message-pages");
const TEMPLATE_SET = templateNames();

type SessionEntry = {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts;
}

/** 取当前分支里最后一条 assistant 消息的文本 */
function lastAssistantMessage(entries: SessionEntry[]): string {
  let last: string = "";
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = extractTextParts(entry.message.content).join("\n").trim();
    if (text.length > 0) last = text;
  }
  return last;
}

function parseArgs(args: string): { template: TemplateName; modelSpec?: string; force: boolean } {
  let template: TemplateName = "clean";
  let modelSpec: string | undefined;
  let force = false;
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--model" && i + 1 < tokens.length) {
      modelSpec = tokens[i + 1];
      i++;
    } else if (t.startsWith("--model=")) {
      modelSpec = t.slice("--model=".length);
    } else if (t === "go") {
      force = true;
    } else if ((TEMPLATE_SET as string[]).includes(t)) {
      template = t as TemplateName;
    }
  }
  return { template, modelSpec, force };
}

function slugify(title: string | undefined, fallback: string): string {
  const base = (title ?? fallback)
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40);
  return base || fallback;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("gen-page-use-latest-msg", {
    description:
      "把最后一条 AI 消息渲染成网页（markdown + 代码高亮 + 决策卡片 + 折叠大纲）。用法：/gen-page-use-latest-msg [模板] [go] [--model provider/model]",
    getArgumentCompletions: (prefix) => {
      const items = [
        ...TEMPLATE_SET.map((t) => ({ value: t, label: `模板: ${t}` })),
        { value: "--model", label: "--model provider/model" },
        { value: "go", label: "强制生成（go）" },
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const { template, modelSpec, force } = parseArgs(args);

      if (ctx.hasUI) {
        ctx.ui.notify("正在取最后一条 AI 消息…", "info");
      }

      const entries = ctx.sessionManager.getBranch();
      const message = lastAssistantMessage(entries as SessionEntry[]);
      if (!message) {
        if (ctx.hasUI) ctx.ui.notify("没有找到 AI 消息，无法渲染", "warning");
        return;
      }

      let model: Model<Api> | undefined;
      if (modelSpec) {
        model = resolveModel(ctx, modelSpec);
        if (!model) {
          if (ctx.hasUI) ctx.ui.notify(`模型解析失败：${modelSpec}`, "warning");
          return;
        }
        if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
          if (ctx.hasUI) ctx.ui.notify(`模型未配置认证：${model.id}`, "warning");
          return;
        }
      } else {
        model = await pickModel(ctx);
        if (!model) return;
      }

      // 记录本次选择的模型，供下次“上次选择”快捷项使用（--model 与选择器都算）
      await writeLastModel(model.provider, model.id);

      if (ctx.hasUI) {
        ctx.ui.notify("正在用大模型提炼决策卡片…", "info");
      }

      let check: DecisionCheck;
      try {
        check = await extractDecisions(ctx, model, message, ctx.signal, force);
      } catch (err) {
        if (ctx.hasUI) {
          ctx.ui.notify(`决策卡片分析失败：${(err as Error).message}`, "warning");
        }
        // 失败时保守处理：仍渲染原文，不让整个命令报废
        check = { hasDecision: true, cards: { decisions: [] } };
      }

      // 模型提炼的分区摘要大纲（有决策时在 cards.sections；无决策长文也可能有）
      const sections = check.hasDecision ? check.cards.sections : check.sections;

      // 非强制模式：无决策且没有可折叠大纲 → 视为无需决策，不生成 HTML
      if (!check.hasDecision && !force && (!sections || sections.length < 2)) {
        const reason = check.reason;
        if (ctx.hasUI) {
          ctx.ui.notify(`这条消息不需要你决策：${reason}`, "info");
        } else {
          process.stdout.write(`[gen-page-use-latest-msg] 无需生成页面：${reason}\n`);
        }
        return;
      }
      // go 模式：即使模型判无决策，也强制生成页面
      const cardResult = check.hasDecision
        ? check.cards
        : { decisions: [], sections: sections ?? [] };

      if (ctx.hasUI) {
        ctx.ui.notify("正在渲染网页…", "info");
      }

      const bodyHtml = markdownToHtml(message);

      // 按标题切分原文成折叠分区；仅当有清晰结构（≥2 块）或模型给了大纲时才用大纲
      const parts = splitMarkdownByHeadings(message);
      const hasOutline = parts.length >= 2 || (sections && sections.length >= 2);
      const blocks: { title?: string; bodyHtml: string }[] | undefined = hasOutline
        ? parts.map((p) => ({ title: p.heading, bodyHtml: markdownToHtml(p.bodyMd) }))
        : undefined;

      const data: PageData = {
        title: cardResult.title,
        summary: cardResult.summary,
        decisions: cardResult.decisions,
        sections,
        blocks,
        bodyHtml,
        modelLabel: `${model.provider}/${model.id}`,
        timestamp: Date.now(),
        template,
      };
      const html = renderPage(data);

      await mkdir(OUTPUT_DIR, { recursive: true });
      const slug = slugify(cardResult.title, "last-ai-message");
      const filename = `${Date.now()}_${slug}.html`;
      const filePath = join(OUTPUT_DIR, filename);
      await writeFile(filePath, html, "utf8");

      const opened = await openInBrowser(pi, filePath);
      const cardCount = cardResult.decisions.length;

      if (ctx.hasUI) {
        ctx.ui.notify(
          `已生成：${filePath}（决策卡片 ${cardCount} 张${opened ? "" : "，浏览器打开失败"}）`,
          "info",
        );
      } else {
        // 无 UI（print/json/rpc）模式：仍是程序正常输出，告诉用户生成路径
        process.stdout.write(`[gen-page-use-latest-msg] ${filePath} (${cardCount} decisions)\n`);
      }
    },
  });
}
