/**
 * thinking-translator — 思维链英译中双栏插件
 *
 * ## 功能
 * 大模型返回英文 thinking 时，实时切分段落并在右侧 overlay 中逐段翻译为中文。
 * 左侧展示英文原文，右侧展示中文翻译，段落对齐。
 * 原始英文 thinking 在 message_end 时还原，不影响 LLM 上下文缓存。
 *
 * ## 配置
 * 直接修改下方 CONFIG 对象即可：
 * - model：翻译模型 ID（留空 = 跟随主模型）
 * - systemPrompt / userPromptWithContext / userPromptNoContext：提示词模板
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";

// ---------------------------------------------------------------------------
// Provider 配置缓存（从 pi 当前模型获取）
// ---------------------------------------------------------------------------

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

let providerConfig: ProviderConfig | null = null;

// ---------------------------------------------------------------------------
// 用户可调配置（直接改这里即可）
// ---------------------------------------------------------------------------

// 定位 prompts.md（与本文件同级）
const __dirname = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return resolve(".");
  }
})();

const PROMPTS_FILE = resolve(__dirname, "prompts.md");

/** 解析 prompts.md 中 `# 标题` 段落 */
function loadPrompts(): Record<string, string> {
  const defaults: Record<string, string> = {
    system:
      "你是一个技术翻译。将英文思考内容翻译为中文。" +
      "保持所有技术术语、代码、数字、标识符不变。" +
      "只返回中文翻译，不要任何解释。",
    "user-with-context":
      "上文（已翻译，仅供参考语境）：\n{context}\n\n翻译以下内容：\n{text}",
    "user-no-context":
      "翻译以下英文思考内容为中文：\n{text}",
  };

  try {
    const raw = readFileSync(PROMPTS_FILE, "utf-8");
    const sections: Record<string, string> = {};
    let currentKey = "";
    const lines: string[] = [];

    for (const line of raw.split("\n")) {
      const h1 = line.match(/^#\s+(.+)/);
      if (h1) {
        if (currentKey && lines.length > 0) {
          sections[currentKey] = lines.join("\n").trimEnd();
        }
        currentKey = h1[1].trim();
        lines.length = 0;
        continue;
      }
      if (currentKey) lines.push(line);
    }
    if (currentKey && lines.length > 0) {
      sections[currentKey] = lines.join("\n").trimEnd();
    }

    // 合并：文件里有的用文件，没有的 fallback 默认值
    return { ...defaults, ...sections };
  } catch {
    return defaults;
  }
}

const PROMPTS = loadPrompts();

/** 判断段落是否以中文为主（无需翻译） */
function isMainlyChinese(text: string): boolean {
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    }
    if (code > 32) total++;
  }
  return total > 0 && cjk / total > 0.5;
}

const CONFIG = {
  /**
   * 翻译模型 ID。
   * 留空则跟随当前对话主模型。
   * 示例：主模型 deepseek-reasoner 时，可设为 "deepseek-chat" 用更便宜的模型翻译
   */
  model: "",

  systemPrompt: PROMPTS["system"],
  userPromptWithContext: PROMPTS["user-with-context"],
  userPromptNoContext: PROMPTS["user-no-context"],
};

// ---------------------------------------------------------------------------

/** 从 ctx 提取 provider 配置（首次调用时） */
function ensureProviderConfig(ctx: ExtensionContext): ProviderConfig | null {
  if (providerConfig) return providerConfig;

  try {
    const model: any = (ctx as any).model;
    if (!model) return null;

    // 尝试从 model 对象获取 provider 配置
    const registry: any = (ctx as any).modelRegistry;

    // 优先从 registry 获取
    let baseUrl = "";
    let apiKey = "";

    if (registry) {
      // registry 可能有 getProvider / providers 等方法
      const provider =
        typeof registry.getProvider === "function"
          ? registry.getProvider(model.provider)
          : null;
      if (provider) {
        baseUrl = provider.baseUrl || "";
        apiKey = provider.apiKey || "";
      }
    }

    // fallback：model 对象本身可能带配置
    if (!baseUrl) baseUrl = model.baseUrl || "";
    if (!apiKey) apiKey = model.apiKey || "";

    if (!baseUrl || !apiKey) return null;

    providerConfig = {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey,
      model: CONFIG.model || model.id || model.name || "",
    };
    return providerConfig;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 全局状态（会话级别）
// ---------------------------------------------------------------------------

/** 英文段落列表 */
let enParagraphs: string[] = [];
/** 中文翻译列表（null = 翻译中） */
let zhParagraphs: (string | null)[] = [];
/** overlay handle */
let panelHandle: { requestRender?: () => void; close?: () => void } | null = null;
/** tui 引用，用于触发重绘 */
let tuiRef: { requestRender: () => void } | null = null;
/** overlay 关闭回调 */
let panelResolve: ((v: unknown) => void) | null = null;
/** 段落缓冲区 */
let paragraphBuffer = "";
/** 翻译队列 */
let translationQueue: TranslationQueue | null = null;
/** 当前 assistant message 中已移除的 thinking 块（位置 → 内容） */
let removedThinkings: { index: number; text: string }[] = [];

// ---------------------------------------------------------------------------
// 段落检测器
// ---------------------------------------------------------------------------

class ParagraphDetector {
  private onParagraph: (text: string) => void;

  constructor(onParagraph: (text: string) => void) {
    this.onParagraph = onParagraph;
  }

  feed(text: string) {
    paragraphBuffer += text;
    // 查找 \n\n（段落分隔）
    while (true) {
      const idx = paragraphBuffer.indexOf("\n\n");
      if (idx === -1) break;
      const paragraph = paragraphBuffer.slice(0, idx).trim();
      paragraphBuffer = paragraphBuffer.slice(idx + 2);
      if (paragraph) {
        this.onParagraph(paragraph);
      }
    }
  }

  flush() {
    const remaining = paragraphBuffer.trim();
    paragraphBuffer = "";
    if (remaining) {
      this.onParagraph(remaining);
    }
  }
}

// ---------------------------------------------------------------------------
// 翻译调度器
// ---------------------------------------------------------------------------

class TranslationQueue {
  private pending: { index: number; text: string }[] = [];
  private running = false;

  enqueue(index: number, text: string) {
    this.pending.push({ index, text });
    this.processNext();
  }

  /** 等待所有翻译完成 */
  async drain(): Promise<void> {
    while (this.running || this.pending.length > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async processNext() {
    if (this.running || this.pending.length === 0) return;
    this.running = true;

    const { index, text } = this.pending.shift()!;

    // 带上已翻译的上文作为 context
    const contextParts: string[] = [];
    for (let i = 0; i < index; i++) {
      if (zhParagraphs[i]) contextParts.push(zhParagraphs[i]!);
    }
    const context = contextParts.length > 0 ? contextParts.join("\n\n") : "";

    try {
      await translateParagraphStreaming(index, text, context);
    } catch {
      zhParagraphs[index] = `[翻译失败] ${text.slice(0, 80)}...`;
    }

    tuiRef?.requestRender();
    this.running = false;
    this.processNext();
  }
}

// ---------------------------------------------------------------------------
// 翻译 API 调用
// ---------------------------------------------------------------------------

async function translateParagraphStreaming(
  index: number,
  text: string,
  context: string
): Promise<void> {
  const cfg = providerConfig;
  if (!cfg) {
    zhParagraphs[index] = `[Provider 配置未就绪] ${text}`;
    return;
  }

  const messages: { role: string; content: string }[] = [
    { role: "system", content: CONFIG.systemPrompt },
  ];

  if (context) {
    messages.push({
      role: "user",
      content: Handlebars.compile(CONFIG.userPromptWithContext, {
        noEscape: true,
      })({ context, text }),
    });
  } else {
    messages.push({
      role: "user",
      content: Handlebars.compile(CONFIG.userPromptNoContext, {
        noEscape: true,
      })({ text }),
    });
  }

  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.3,
      max_tokens: 4096,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Translation API error: ${response.status}`);
  }

  // 流式读取 SSE
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accumulated = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";

    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data: ")) continue;
      const data = s.slice(6);
      if (data === "[DONE]") continue;

      try {
        const token = (JSON.parse(data) as any)?.choices?.[0]?.delta?.content;
        if (token) {
          accumulated += token;
          zhParagraphs[index] = accumulated;
          tuiRef?.requestRender();
        }
      } catch {
        // 忽略解析失败的 chunk
      }
    }
  }

  const result = accumulated.trim();
  zhParagraphs[index] = result || text;
  tuiRef?.requestRender();
}

// ---------------------------------------------------------------------------
// 简单文本换行（不依赖外部包）
// ---------------------------------------------------------------------------

function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > maxWidth) {
      // 在 maxWidth 处找最近的空格
      let cut = maxWidth;
      while (cut > 0 && remaining[cut] !== " ") cut--;
      if (cut === 0) cut = maxWidth; // 没有空格，硬切
      lines.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining.length > 0) {
      lines.push(remaining);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 双栏 Overlay 组件
// ---------------------------------------------------------------------------

class DualPanel {
  private theme: any;

  constructor(theme: any) {
    this.theme = theme;
  }

  handleInput(_data: string): void {
    // 只读面板，不处理输入
  }

  invalidate(): void {
    // 清除渲染缓存（如有）
  }

  render(width: number): string[] {
    const t = this.theme;
    const total = enParagraphs.length;
    if (total === 0) {
      return [t.fg("dim", "  等待 thinking…")];
    }

    const colWidth = Math.floor((width - 5) / 2);
    if (colWidth < 15) {
      return [t.fg("warning", "终端太窄")];
    }

    // 估算可用行数（overlay 高度约为终端的 70%）
    const maxLines = Math.max(10, Math.floor((process.stdout.rows || 40) * 0.55));
    const headerLines = 3;
    const bodyBudget = maxLines - headerLines;

    // 从最新段落倒推，看能装下多少
    let usedLines = 0;
    let startIndex = total;
    for (let i = total - 1; i >= 0; i--) {
      const enLines = wrapText(enParagraphs[i], colWidth - 1);
      const zh = zhParagraphs[i];
      const zhLines = zh
        ? wrapText(zh, colWidth - 1)
        : [t.fg("dim", " ⏳ 翻译中…")];
      const paraHeight = Math.max(enLines.length, zhLines.length) + 1;
      if (usedLines + paraHeight > bodyBudget) break;
      usedLines += paraHeight;
      startIndex = i;
    }
    if (startIndex >= total) startIndex = total - 1;

    const lines: string[] = [];

    // 标题栏
    const bar = "─".repeat(colWidth);
    const enTitle = t.fg("accent", padCenter(" English ", colWidth));
    const zhTitle = t.fg("accent", padCenter(" 中文 ", colWidth));
    lines.push(`┌${bar}┬${bar}┐`);
    lines.push(`│${enTitle}│${zhTitle}│`);
    lines.push(`├${bar}┼${bar}┤`);

    // 段落
    for (let i = startIndex; i < total; i++) {
      const enLines = wrapText(enParagraphs[i], colWidth - 1);
      const zh = zhParagraphs[i];
      const zhLines = zh
        ? wrapText(zh, colWidth - 1)
        : [t.fg("dim", " ⏳ 翻译中…")];

      const maxLineCount = Math.max(enLines.length, zhLines.length);

      for (let j = 0; j < maxLineCount; j++) {
        const en = (enLines[j] || "").padEnd(colWidth);
        const zn = (zhLines[j] || "").padEnd(colWidth);
        lines.push(`│${en}│${zn}│`);
      }

      // 段落间分隔线
      if (i < total - 1) {
        lines.push(`├${bar}┼${bar}┤`);
      }
    }

    lines.push(`└${bar}┴${bar}┘`);

    // 底部状态
    if (total > 0 && startIndex > 0) {
      const remain = startIndex;
      lines.push(t.fg("dim", `  … 上方还有 ${remain} 段`));
    }

    return lines;
  }
}

function padCenter(s: string, width: number): string {
  const pad = width - s.length;
  if (pad <= 0) return s.slice(0, width);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return " ".repeat(left) + s + " ".repeat(right);
}

// ---------------------------------------------------------------------------
// 会话级别重置
// ---------------------------------------------------------------------------

function resetState() {
  enParagraphs = [];
  zhParagraphs = [];
  paragraphBuffer = "";
  removedThinkings = [];
  translationQueue = new TranslationQueue();
  closeOverlay();
}

function closeOverlay() {
  if (panelResolve) {
    panelResolve(null);
    panelResolve = null;
  }
  panelHandle = null;
  tuiRef = null;
}

// ---------------------------------------------------------------------------
// Overlay 生命周期
// ---------------------------------------------------------------------------

function openOverlay(ctx: ExtensionContext, theme: any) {
  if (panelHandle) return; // 已打开

  const panel = new DualPanel(theme);

  void ctx.ui.custom<null>((tui, _t, _kb, done) => {
    tuiRef = tui;
    panelResolve = done;
    return panel;
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "right-top",
      width: "42%",
      minWidth: 36,
      maxHeight: "75%",
    },
    onHandle: (h: any) => {
      panelHandle = h;
    },
  });
}

// ===========================================================================
// 插件入口
// ===========================================================================

export default function thinkingTranslator(pi: ExtensionAPI): void {
  // 会话启动时初始化
  pi.on("session_start", (_event, _ctx) => {
    resetState();
  });

  // 会话关闭时清理
  pi.on("session_shutdown", (_event, _ctx) => {
    closeOverlay();
  });

  // 流式更新——核心逻辑
  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const content = event.message.content;
    if (!Array.isArray(content)) return;

    // 收集所有 thinking 块
    const thinkings: { index: number; text: string }[] = [];
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i] as any;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        thinkings.unshift({ index: i, text: block.thinking });
      }
    }

    if (thinkings.length === 0) return;

    // 初始化 provider 配置（首次）
    ensureProviderConfig(ctx);

    // 从 content 中移除 thinking 块（抑制 pi 默认渲染）
    const filtered = content.filter((c: any) => c.type !== "thinking");
    event.message.content = filtered;

    // 打开 overlay（首次）
    if (!panelHandle) {
      openOverlay(ctx, ctx.ui.theme);
    }

    // 喂入段落检测器
    for (const { index, text } of thinkings) {
      // 只取增量（本次新增的 thinking 文本）
      const prev = removedThinkings.find((r) => r.index === index);
      if (prev) {
        // 已经处理过一部分，只取增量
        if (text.startsWith(prev.text)) {
          const delta = text.slice(prev.text.length);
          prev.text = text;
          if (delta) feedThinking(delta);
        } else {
          // 文本变了（不太可能，但兜底）
          prev.text = text;
        }
      } else {
        // 新 thinking 块
        removedThinkings.push({ index, text });
        feedThinking(text);
      }
    }
  });

  function feedThinking(text: string) {
    const detector = new ParagraphDetector((para) => {
      const idx = enParagraphs.length;
      enParagraphs.push(para);

      if (isMainlyChinese(para)) {
        // 中文段落：直接复制，不翻译
        zhParagraphs.push(para);
      } else {
        zhParagraphs.push(null);
        translationQueue?.enqueue(idx, para);
      }
      tuiRef?.requestRender();
    });
    detector.feed(text);
  }

  // 消息完成——收尾
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;

    // 冲刷段落缓冲区
    if (paragraphBuffer.trim()) {
      const idx = enParagraphs.length;
      enParagraphs.push(paragraphBuffer.trim());
      zhParagraphs.push(null);
      translationQueue?.enqueue(idx, paragraphBuffer.trim());
      paragraphBuffer = "";
    }

    // 等翻译队列清空
    if (translationQueue) {
      await translationQueue.drain();
    }

    // 还原原始英文 thinking 到 message.content
    let finalMessage = event.message;
    const content = event.message.content;
    if (Array.isArray(content) && removedThinkings.length > 0) {
      const restored: any[] = [];
      let thinkingIdx = 0;
      removedThinkings.sort((a, b) => a.index - b.index);

      for (let i = 0; i < content.length + removedThinkings.length; i++) {
        if (
          thinkingIdx < removedThinkings.length &&
          removedThinkings[thinkingIdx].index === i
        ) {
          restored.push({
            type: "thinking",
            thinking: removedThinkings[thinkingIdx].text,
          });
          thinkingIdx++;
        } else {
          const contentIdx = i - thinkingIdx;
          if (contentIdx < content.length) {
            restored.push(content[contentIdx]);
          }
        }
      }

      finalMessage = { ...event.message, content: restored };
    }

    // 关闭 overlay + 重置状态
    closeOverlay();
    enParagraphs = [];
    zhParagraphs = [];
    removedThinkings = [];
    translationQueue = new TranslationQueue();

    if (finalMessage !== event.message) {
      return { message: finalMessage };
    }
  });

  // context 事件不需要特殊处理——message_end 已经还原了英文
  // pi 存入 session 的是英文原文，context 直接发送英文
}
