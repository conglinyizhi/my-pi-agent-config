import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { markdownToHtml } from "./src/markdown.ts";
import { extractDecisions, type DecisionCheck } from "./src/cards.ts";
import { pickModel } from "./src/model.ts";
import { writeLastModel } from "./src/prefs.ts";
import { renderPage, templateNames, type PageData, type TemplateName } from "./src/templates.ts";
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

function parseArgs(args: string): { template: TemplateName; modelSpec?: string } {
  let template: TemplateName = "clean";
  let modelSpec: string | undefined;
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--model" && i + 1 < tokens.length) {
      modelSpec = tokens[i + 1];
      i++;
    } else if (t.startsWith("--model=")) {
      modelSpec = t.slice("--model=".length);
    } else if ((TEMPLATE_SET as string[]).includes(t)) {
      template = t as TemplateName;
    }
  }
  return { template, modelSpec };
}

function resolveModelFromSpec(ctx: ExtensionCommandContext, spec: string): Model<Api> | undefined {
  const slash = spec.indexOf("/");
  if (slash < 0) return undefined;
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  return ctx.modelRegistry.find(provider, id);
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
      "把最后一条 AI 消息渲染成网页（markdown + 代码高亮 + 决策卡片）。用法：/gen-page-use-latest-msg [模板] [--model provider/model]",
    getArgumentCompletions: (prefix) => {
      const items = [
        ...TEMPLATE_SET.map((t) => ({ value: t, label: `模板: ${t}` })),
        { value: "--model", label: "--model provider/model" },
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const { template, modelSpec } = parseArgs(args);

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
        model = resolveModelFromSpec(ctx, modelSpec);
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
        check = await extractDecisions(ctx, model, message, ctx.signal);
      } catch (err) {
        if (ctx.hasUI) {
          ctx.ui.notify(`决策卡片分析失败：${(err as Error).message}`, "warning");
        }
        // 失败时保守处理：仍渲染原文，不让整个命令报废
        check = { hasDecision: true, cards: { decisions: [] } };
      }

      // 模型判定无需用户决策 → 不生成 HTML，直接提示
      if (!check.hasDecision) {
        const reason = check.reason;
        if (ctx.hasUI) {
          ctx.ui.notify(`这条消息不需要你决策：${reason}`, "info");
        } else {
          process.stdout.write(`[gen-page-use-latest-msg] 无需生成页面：${reason}\n`);
        }
        return;
      }
      const cards = check.cards;

      if (ctx.hasUI) {
        ctx.ui.notify("正在渲染网页…", "info");
      }

      const bodyHtml = markdownToHtml(message);

      const data: PageData = {
        title: cards.title,
        summary: cards.summary,
        decisions: cards.decisions,
        bodyHtml,
        modelLabel: `${model.provider}/${model.id}`,
        timestamp: Date.now(),
        template,
      };
      const html = renderPage(data);

      await mkdir(OUTPUT_DIR, { recursive: true });
      const slug = slugify(cards.title, "last-ai-message");
      const filename = `${Date.now()}_${slug}.html`;
      const filePath = join(OUTPUT_DIR, filename);
      await writeFile(filePath, html, "utf8");

      const opened = await openInBrowser(pi, filePath);
      const cardCount = cards.decisions.length;

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
