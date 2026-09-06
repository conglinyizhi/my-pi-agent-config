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

/** 给原文顶层 block 生成 src-N 锚点 id，供“更多决策信息”跳转定位。 */
function addAnchors(html: string): string {
  let n = 0;
  return html.replace(/<(h1|h2|h3|h4|h5|pre|p|blockquote|table|ul|ol|div)([^<>]*)>/g, (m, tag, attrs) => {
    if (/\bid=/.test(attrs)) return m;
    return `<${tag} id="src-${n++}"${attrs}>`;
  });
}

/** 提取用于锚点匹配的搜索词：优先 source，否则取 question 去标点。 */
function extractSearch(d: Decision): string {
  if (d.source && d.source.trim()) return d.source.trim();
  return (d.question || "").replace(/[，。？！；：、·,\.\?!;:\s]/g, "").slice(0, 24);
}

/** 把大段落文本按换行拆成带转义的 <p>，用于“我无法决策”的展开说明。 */
function paragraphs(text: string): string {
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `<p>${escapeHtml(s)}</p>`)
    .join("");
}

function decisionCards(decisions: Decision[]): string {
  if (decisions.length === 0) {
    return "";
  }
  const cards = decisions.map((d, idx) => {
    const p = PRIORITY[d.priority];
    const modelOpts = d.options
      .map((o) => `<li class="opt" data-v="${escapeHtml(o)}">${escapeHtml(o)}</li>`)
      .join("");
    const options =
      `<ol class="opts">${modelOpts}` +
      `<li class="opt opt-custom" data-v="__custom__">自定义…</li>` +
      `<li class="opt opt-cant" data-v="我无法决策">我无法决策</li>` +
      `</ol>`;
    const cantPanel = d.cannotDecide
      ? `<div class="cant-panel" hidden>${paragraphs(d.cannotDecide)}</div>`
      : "";
    const rec = d.recommendation
      ? `<div class="rec"><span class="rec-tag">建议</span>${escapeHtml(d.recommendation)}</div>`
      : "";
    const why = d.reasoning
      ? `<div class="why">${escapeHtml(d.reasoning)}</div>`
      : "";
    return [
      `<article class="dcard ${p.cls}" data-idx="${idx}" data-search="${escapeHtml(extractSearch(d))}">`,
      `<div class="dcard-head">`,
      `<span class="pr-badge ${p.cls}">${p.label}</span>`,
      `<h3 class="q">${escapeHtml(d.question)}</h3>`,
      `<button class="more-btn" type="button" data-id="${idx}">更多决策信息</button>`,
      `</div>`,
      options,
      rec,
      why,
      cantPanel,
      `<div class="chosen" hidden></div>`,
      `</article>`,
    ].join("");
  });
  return `<div class="cards">${cards.join("")}</div>`;
}

const INTERACTION_JS = `
(function(){
  var cards = Array.prototype.slice.call(document.querySelectorAll('.dcard'));
  var body = document.getElementById('markdown-body');

  // 点击选项 → 选中；点已选的可取消；随时可改选（不永久锁定）
  document.addEventListener('click', function(e){
    var opt = e.target.closest('.opt');
    if(!opt) return;
    var card = opt.closest('.dcard');
    if(opt.classList.contains('opt-custom')){
      handleCustom(opt, card, e);
      return;
    }
    selectStandard(opt, card);
  });

  function clearAll(card){
    card.querySelectorAll('.opt').forEach(function(o){
      o.classList.remove('selected');
      o.classList.remove('disabled');
    });
    var panel = card.querySelector('.cant-panel');
    if(panel) panel.hidden = true;
  }

  function selectStandard(opt, card){
    var chosen = card.querySelector('.chosen');
    var wasSelected = opt.classList.contains('selected');
    clearAll(card);
    if(!wasSelected){
      opt.classList.add('selected');
      if(chosen){
        chosen.hidden = false;
        chosen.textContent = '已选：' + (opt.getAttribute('data-v') || opt.textContent.trim());
      }
      if(opt.classList.contains('opt-cant')){
        var panel = card.querySelector('.cant-panel');
        if(panel) panel.hidden = false;
      }
    } else {
      if(chosen){ chosen.hidden = true; chosen.textContent = ''; }
    }
  }

  function handleCustom(opt, card){
    if(opt.querySelector('input')) return;
    var label = opt.textContent.trim();
    opt.textContent = '';
    var input = document.createElement('input');
    input.className = 'opt-input';
    input.placeholder = '输入你的选项…';
    opt.appendChild(input);
    input.focus();
    function commit(){
      var val = input.value.trim();
      if(val){
        opt.dataset.v = val;
        opt.textContent = val;
        clearAll(card);
        var chosen = card.querySelector('.chosen');
        if(chosen){ chosen.hidden = false; chosen.textContent = '已选：' + val; }
      } else {
        opt.textContent = label;
        opt.dataset.v = '__custom__';
      }
    }
    input.addEventListener('keydown', function(ev){ if(ev.key === 'Enter'){ ev.preventDefault(); commit(); } });
    input.addEventListener('blur', commit);
  }

  // 更多决策信息 → 原文锚点跳转 + 高亮
  document.querySelectorAll('.more-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      gotoBlock(parseInt(btn.getAttribute('data-id'), 10));
    });
  });

  function gotoBlock(idx){
    var card = cards[idx];
    if(!card) return;
    clearHighlight();
    var search = card.getAttribute('data-search') || '';
    var target = findBlock(search);
    if(!target && body){
      target = body.querySelector('[id^="src-"]');
    }
    if(target){
      target.scrollIntoView({behavior:'smooth', block:'center'});
      target.classList.add('flash-highlight');
    }
  }

  function findBlock(search){
    if(!search || !body) return null;
    var blocks = body.querySelectorAll('[id^="src-"]');
    for(var i=0;i<blocks.length;i++){
      if(blocks[i].textContent.indexOf(search) >= 0) return blocks[i];
    }
    return null;
  }

  function clearHighlight(){
    var h = body ? body.querySelectorAll('.flash-highlight') : [];
    for(var i=0;i<h.length;i++){ h[i].classList.remove('flash-highlight'); }
  }

  // 复制决策（整合每个决策的选择 + 全局批注）
  var copyBtn = document.getElementById('copy-decisions');
  var status = document.getElementById('copy-status');
  if(copyBtn){
    copyBtn.addEventListener('click', function(){
      var text = buildExportText();
      var ok = copyText(text);
      status.textContent = ok ? '已复制到剪贴板' : '复制失败，请手动复制';
      setTimeout(function(){ status.textContent=''; }, 2600);
    });
  }

  function buildExportText(){
    var lines = [];
    cards.forEach(function(card, i){
      var q = card.querySelector('.q');
      var selected = card.querySelector('.opt.selected');
      var chosen = card.querySelector('.chosen');
      var chosenText = chosen && !chosen.hidden ? chosen.textContent.trim() : '';
      var val = selected ? (selected.getAttribute('data-v') || selected.textContent.trim()) : '';
      lines.push('【' + (i+1) + '】' + (q ? q.textContent.trim() : '决策 ' + (i+1)));
      lines.push('  我的选择：' + (val || chosenText || '未选择（开放问题）'));
    });
    var note = document.getElementById('note');
    if(note && note.value.trim()){
      lines.push('');
      lines.push('批注：' + note.value.trim());
    }
    return lines.join('\\n');
  }

  function copyText(text){
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try{ ok = document.execCommand('copy'); }catch(err){ ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // 回到顶部
  var toTop = document.getElementById('to-top');
  if(toTop){
    window.addEventListener('scroll', function(){
      toTop.style.display = window.scrollY > 400 ? 'flex' : 'none';
    });
    toTop.addEventListener('click', function(){
      window.scrollTo({top:0, behavior:'smooth'});
    });
  }
})();
`;

function shell(
  { title, summary, decisions, bodyHtml, modelLabel, timestamp, template }: PageData,
  css: string,
): string {
  const pageTitle = title ? escapeHtml(title) : "最后一条 AI 消息";
  const timeLabel = new Date(timestamp).toLocaleString("zh-CN");
  const anchoredBody = addAnchors(bodyHtml);
  const decHtml = decisionCards(decisions);
  const exportBox =
    decisions.length > 0
      ? `<section class="export-box">
          <div class="export-title">批注与导出</div>
          <label class="note-label" for="note">写下你对这次决策的批注 / 备注（会随选择一起整合到复制内容里）</label>
          <textarea id="note" class="note" placeholder="例如：同意方案 A，但需确认迁移窗口…"></textarea>
          <button id="copy-decisions" class="copy-btn" type="button">复制决策</button>
          <div id="copy-status" class="copy-status"></div>
        </section>`
      : "";
  const decSection =
    decisions.length > 0
      ? `<section class="decisions"><div class="section-label">需要你拍板</div>${decHtml}${exportBox}</section>`
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
        <div class="markdown-body" id="markdown-body">${anchoredBody}</div>
      </section>
    </main>
    <footer class="foot">— 由 message-page 插件生成 · 决策卡片由大模型提炼，仅供参考 —</footer>
  </div>
  <button id="to-top" type="button" title="回到顶部">↑</button>
  <script>${INTERACTION_JS}</script>
</body>
</html>`;
}

/* 模板 CSS ─────────────────────────────────────────── */

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;line-height:1.65;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.page{max-width:780px;margin:0 auto;padding:40px 28px 120px}
.crumb{font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
.title{margin:0 0 8px;font-size:26px;font-weight:700;line-height:1.25}
.meta{font-size:12px;opacity:.75;display:flex;gap:8px;align-items:center;margin-bottom:16px}
.summary{font-size:15px;margin:0 0 4px}
.section-label{font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;margin:32px 0 14px}
.none{font-size:14px;opacity:.7}
/* 卡片单列占满一行 */
.cards{display:grid;grid-template-columns:1fr;gap:14px}
.dcard{position:relative;padding:16px 18px 16px 20px;border-radius:10px}
.dcard-head{display:flex;align-items:flex-start;gap:12px}
.dcard-head .pr-badge{flex:none;margin:3px 0 0}
.dcard-head .q{flex:1;margin:0 0 6px}
.more-btn{flex:none;font-size:12px;padding:4px 10px;border:1px solid var(--card-border);background:transparent;color:var(--fg);border-radius:999px;cursor:pointer;opacity:.82;font-family:inherit}
.more-btn:hover{opacity:1;border-color:var(--accent);color:var(--accent)}
.dcard .pr-badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;margin-bottom:10px}
.dcard .q{margin:0 0 10px;font-size:16px;font-weight:650;line-height:1.4}
.dcard .opts{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:14px}
.dcard .opt{padding:8px 12px;border:1px solid var(--card-border);border-radius:8px;cursor:pointer;transition:border-color .15s,background .15s;color:var(--fg)}
.dcard .opt:hover{border-color:var(--accent)}
.dcard .opt.selected{border-color:var(--accent);background:var(--card-bg);font-weight:600;box-shadow:inset 0 0 0 1px var(--accent)}
.dcard .opt.selected::before{content:"✓ ";color:var(--accent);font-weight:700}
.dcard .opt.disabled{opacity:.42;pointer-events:none}
.dcard .opt-custom,.dcard .opt-cant{border-style:dashed;color:var(--muted)}
.dcard .opt-custom:hover,.dcard .opt-cant:hover{border-color:var(--accent);color:var(--fg)}
.dcard .opt-cant{color:var(--p-medium);border-color:var(--p-medium)}
.dcard .opt-cant:hover{border-color:var(--p-medium);color:var(--p-medium)}
.dcard .opt-input{width:100%;padding:7px 10px;border:1px solid var(--accent);border-radius:8px;background:transparent;color:var(--fg);font-size:14px;font-family:inherit}
.dcard .opt-input:focus{outline:none}
.cant-panel{margin-top:12px;padding:12px 14px;border-left:3px solid var(--p-medium);background:var(--card-bg);border-radius:6px}
.cant-panel p{margin:.5em 0;font-size:14px;line-height:1.7;color:var(--muted)}
.dcard .rec{margin-top:12px;font-size:14px}
.dcard .rec-tag{font-weight:700;margin-right:6px;font-size:12px}
.dcard .why{margin-top:8px;font-size:13px;opacity:.78}
.dcard .chosen{margin-top:10px;font-size:13px;font-weight:600;color:var(--accent)}
/* 导出区 */
.export-box{margin-top:14px;padding:14px 18px;border:1px solid var(--card-border);border-radius:12px;background:var(--card-bg)}
.export-title{font-size:13px;font-weight:700;margin:0 0 10px;letter-spacing:.04em}
.export-box .note-label{display:block;font-size:13px;opacity:.82;margin-bottom:8px}
.export-box .note{width:100%;min-height:84px;padding:10px 12px;border:1px solid var(--card-border);border-radius:8px;background:transparent;color:var(--fg);font-size:14px;resize:vertical;font-family:inherit}
.export-box .note:focus{outline:none;border-color:var(--accent)}
.export-box .copy-btn{margin-top:10px;padding:8px 16px;border:0;border-radius:8px;background:var(--accent);color:var(--card-bg);font-weight:600;cursor:pointer;font-size:14px;font-family:inherit}
.export-box .copy-btn:hover{filter:brightness(1.08)}
.copy-status{margin-top:6px;font-size:12px;opacity:.8}
/* 原文锚点高亮 */
.flash-highlight{background:rgba(255,214,79,.34)!important;box-shadow:0 0 0 3px rgba(255,196,60,.55);border-radius:4px;transition:background .3s}
/* 回到顶部 */
#to-top{position:fixed;right:26px;bottom:26px;width:42px;height:42px;border-radius:50%;border:1px solid var(--card-border);background:var(--card-bg);color:var(--fg);font-size:18px;cursor:pointer;display:none;align-items:center;justify-content:center;z-index:50;opacity:.9;box-shadow:0 2px 8px rgba(0,0,0,.12)}
#to-top:hover{opacity:1;border-color:var(--accent);color:var(--accent)}
.foot{margin-top:56px;font-size:12px;opacity:.55;text-align:center}
/* 响应式 */
@media (max-width:520px){.page{padding:24px 14px 110px}.title{font-size:22px}.dcard{padding:14px 14px 14px 16px}}
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
.dcard-head .q{font-family:Georgia,serif;font-weight:600}
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
