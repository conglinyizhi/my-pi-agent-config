import { loadHighlightCss, type HighlightTheme } from "./markdown.ts";
import type { Decision, DecisionPriority } from "./cards.ts";

export type TemplateName = "clean" | "cards" | "paper";

export interface PageData {
  title?: string;
  summary?: string;
  decisions: Decision[];
  bodyHtml: string;
  modelLabel: string;
  timestamp: number;
  template: TemplateName;
}

const PRIORITY: Record<DecisionPriority, { label: string; cls: string }> = {
  high: { label: "高", cls: "pr-high" },
  medium: { label: "中", cls: "pr-medium" },
  low: { label: "低", cls: "pr-low" },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decisionCards(decisions: Decision[]): string {
  if (decisions.length === 0) {
    return "";
  }
  const cards = decisions.map((d) => {
    const p = PRIORITY[d.priority];
    const options =
      d.options.length > 0
        ? `<ol class="opts">${d.options.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ol>`
        : "";
    const rec = d.recommendation
      ? `<div class="rec"><span class="rec-tag">建议</span>${escapeHtml(d.recommendation)}</div>`
      : "";
    const why = d.reasoning
      ? `<div class="why">${escapeHtml(d.reasoning)}</div>`
      : "";
    return [
      `<article class="dcard ${p.cls}">`,
      `<span class="pr-badge ${p.cls}">${p.label}</span>`,
      `<h3 class="q">${escapeHtml(d.question)}</h3>`,
      options,
      rec,
      why,
      `</article>`,
    ].join("");
  });
  return `<div class="cards">${cards.join("")}</div>`;
}

function shell(
  { title, summary, decisions, bodyHtml, modelLabel, timestamp, template }: PageData,
  css: string,
): string {
  const pageTitle = title ? escapeHtml(title) : "最后一条 AI 消息";
  const timeLabel = new Date(timestamp).toLocaleString("zh-CN");
  const decHtml = decisionCards(decisions);
  const decSection =
    decisions.length > 0
      ? `<section class="decisions"><div class="section-label">需要你拍板</div>${decHtml}</section>`
      : `<section class="decisions"><div class="section-label">需要你拍板</div><p class="none">这条消息里没有需要你拍板的问题。</p></section>`;
  const summaryBlock = summary
    ? `<p class="summary">${escapeHtml(summary)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<style>${loadHighlightCss(highlightThemeFor(template))}</style>
<style>${css}</style>
</head>
<body class="tpl-${template}">
  <div class="page">
    <header class="pagehead">
      <div class="crumb">最后一条 AI 消息</div>
      <h1 class="title">${pageTitle}</h1>
      <div class="meta"><span>${escapeHtml(modelLabel)}</span><span>·</span><span>${timeLabel}</span><span>·</span><span>${template}</span></div>
      ${summaryBlock}
    </header>
    <main>
      ${decSection}
      <section class="body">
        <div class="section-label">原文</div>
        <div class="markdown-body">${bodyHtml}</div>
      </section>
    </main>
    <footer class="foot">— 由 message-page 插件生成 · 决策卡片由大模型提炼，仅供参考 —</footer>
  </div>
</body>
</html>`;
}

/* 模板 CSS ─────────────────────────────────────────── */

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;line-height:1.65;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.page{max-width:780px;margin:0 auto;padding:40px 28px 80px}
.crumb{font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
.title{margin:0 0 8px;font-size:26px;font-weight:700;line-height:1.25}
.meta{font-size:12px;opacity:.75;display:flex;gap:8px;align-items:center;margin-bottom:16px}
.summary{font-size:15px;margin:0 0 4px}
.section-label{font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;margin:32px 0 14px}
.none{font-size:14px;opacity:.7}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.dcard{position:relative;padding:16px 18px 16px 20px;border-radius:10px}
.dcard .pr-badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;margin-bottom:10px}
.dcard .q{margin:0 0 10px;font-size:16px;font-weight:650;line-height:1.4}
.dcard .opts{margin:10px 0 0;padding-left:20px;font-size:14px}
.dcard .opts li{margin:3px 0}
.dcard .rec{margin-top:12px;font-size:14px}
.dcard .rec-tag{font-weight:700;margin-right:6px;font-size:12px}
.dcard .why{margin-top:8px;font-size:13px;opacity:.78}
.foot{margin-top:56px;font-size:12px;opacity:.55;text-align:center}
/* markdown body */
.markdown-body{font-size:15px}
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{margin:1.4em 0 .5em;font-weight:650;line-height:1.3}
.markdown-body h1{font-size:1.5em}.markdown-body h2{font-size:1.3em}.markdown-body h3{font-size:1.12em}
.markdown-body p{margin:.7em 0}
.markdown-body a{text-decoration:none}
.markdown-body a:hover{text-decoration:underline}
.markdown-body code{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:.88em;padding:.15em .4em;border-radius:5px}
.markdown-body pre{overflow-x:auto;padding:14px 16px;border-radius:10px;font-size:13.5px;line-height:1.55}
.markdown-body pre code{padding:0;background:transparent;font-size:inherit}
.markdown-body blockquote{margin:1em 0;padding:.3em 1em;border-left:3px solid;font-size:14px}
.markdown-body ul,.markdown-body ol{margin:.7em 0;padding-left:24px}
.markdown-body li{margin:3px 0}
.markdown-body table{border-collapse:collapse;width:100%;margin:1em 0;font-size:14px}
.markdown-body th,.markdown-body td{padding:6px 10px;border:1px solid;text-align:left}
.markdown-body img{max-width:100%;border-radius:8px}
.markdown-body hr{border:0;border-top:1px solid;margin:2em 0}
`;

const MAIN_BODY = `
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{color:var(--fg)}
.markdown-body blockquote{color:var(--muted);border-left-color:var(--muted)}
.markdown-body th,.markdown-body td{border-color:var(--card-border)}
`;

/**
 * clean —— 浅色简洁阅读风
 */
const TPL_CLEAN = `
${BASE_CSS}
:root{
  --bg:#ffffff;--fg:#1f2328;--muted:#59626d;
  --card-bg:#f6f8fa;--card-border:#d8dee4;
  --p-high:#d1242f;--p-medium:#bf8700;--p-low:#0969da;
  --accent:#0969da;--code-bg:#f0f1f3;
}
body{background:var(--bg);color:var(--fg)}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.crumb{color:var(--accent)}
.meta{color:var(--muted)}
.summary{color:var(--muted)}
.dcard{background:var(--card-bg);border:1px solid var(--card-border);border-left:4px solid var(--p-low)}
.dcard.pr-high{border-left-color:var(--p-high)}
.dcard.pr-low{border-left-color:var(--p-low)}
.dcard.pr-medium{border-left-color:var(--p-medium)}
.pr-badge.pr-high{background:var(--p-high);color:#fff}
.pr-badge.pr-medium{background:var(--p-medium);color:#fff}
.pr-badge.pr-low{background:var(--p-low);color:#fff}
.rec .rec-tag{color:var(--accent)}
.why{color:var(--muted)}
.markdown-body code{background:var(--code-bg);color:#c7254e}
.markdown-body a{color:var(--accent)}
.markdown-body hr{border-color:var(--card-border)}
${MAIN_BODY}
`;

/**
 * cards —— 深色、卡片主导，决策点强烈突出
 */
const TPL_CARDS = `
${BASE_CSS}
:root{
  --bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;
  --card-bg:#161b22;--card-border:#30363d;
  --p-high:#ff7b72;--p-medium:#e3b341;--p-low:#79c0ff;
  --accent:#58a6ff;--code-bg:#161b22;
}
body{background:var(--bg);color:var(--fg)}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.crumb{color:var(--accent)}
.meta{color:var(--muted)}
.summary{color:var(--muted)}
.dcard{background:var(--card-bg);border:1px solid var(--card-border);border-left:5px solid var(--p-high)}
.dcard.pr-high{box-shadow:0 1px 8px rgba(255,123,114,.18)}
.pr-badge.pr-high{background:var(--p-high);color:#0d1117}
.pr-badge.pr-medium{background:var(--p-medium);color:#0d1117}
.pr-badge.pr-low{background:var(--p-low);color:#0d1117}
.rec .rec-tag{color:var(--accent)}
.why{color:var(--muted)}
.markdown-body code{background:var(--code-bg);color:#e6edf3}
.markdown-body a{color:var(--accent)}
.markdown-body hr{border-color:var(--card-border)}
${MAIN_BODY}
`;

/**
 * paper —— 米白衬线，论文式排版
 */
const TPL_PAPER = `
${BASE_CSS}
:root{
  --bg:#faf6ef;--fg:#2c2620;--muted:#6f6357;
  --card-bg:#f2ecde;--card-border:#d9cfbc;
  --p-high:#a8332e;--p-medium:#8a6d1a;--p-low:#3f6b8a;
  --accent:#5b4a34;--code-bg:#efe8d8;
}
body{background:var(--bg);color:var(--fg)}
body{font-family:Georgia,"Times New Roman","Songti SC","SimSun",serif}
.crumb{color:var(--accent)}
.meta{color:var(--muted)}
.summary{color:var(--muted);font-style:italic}
.page{max-width:680px}
.title{font-family:Georgia,serif;font-weight:700;letter-spacing:.2px}
.dcard{background:var(--card-bg);border:1px solid var(--card-border)}
.dcard{box-shadow:0 1px 2px rgba(0,0,0,.04)}
.dcard .q{font-family:Georgia,serif;font-weight:600}
.rec .rec-tag{color:var(--accent);letter-spacing:.04em}
.why{color:var(--muted);font-style:italic}
.markdown-body code{background:var(--code-bg);color:#7a3b2e}
.markdown-body a{color:var(--accent)}
.markdown-body hr{border-color:var(--card-border)}
${MAIN_BODY}
`;

const TEMPLATES: Record<TemplateName, string> = {
  clean: TPL_CLEAN,
  cards: TPL_CARDS,
  paper: TPL_PAPER,
};

export function renderPage(data: PageData): string {
  const css = TEMPLATES[data.template] ?? TPL_CLEAN;
  return shell(data, css);
}

export function templateNames(): TemplateName[] {
  return ["clean", "cards", "paper"];
}

export function highlightThemeFor(template: TemplateName): HighlightTheme {
  return template === "cards" ? "github-dark" : template === "paper" ? "github" : "github-dark";
}
