// 语法着色的接入层：shiki 出 token（带 offset），剩下的活我们自己干。
//
// 为什么是 shiki 而不是别家：它给的是 **token 级** 结果（content + offset + color），
// 而审核窗要把"语法颜色"和"规则/赋值/变量三类标记"叠在同一段文本上——只给 HTML
// 的高亮库（highlight.js 那类）没法这么拼。语法用 VSCode 同一套 TextMate 语法，
// 引擎走纯 JS 正则版（不用 wasm），离线可用。
//
// 两道防线：
//   1. 着色是异步加载的，加载失败就当没有颜色——绝不因为着色失败少显示一个字符
//   2. 拼 HTML 是纯函数（tokens + marks → html），可以脱离 shiki 单测

let highlighterPromise;

/** 懒加载 highlighter：整个窗口只建一次 */
export function getHighlighter() {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [import("shiki/themes/github-dark.mjs")],
      langs: [import("shiki/langs/javascript.mjs")],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighterPromise;
}

/**
 * 取一段代码的 token（全局坐标，扁平）。lang 为空或着色失败时返回空数组——
 * 调用方据此退回不上色的渲染，而不是不显示。
 */
export async function colorTokens(text, lang = "javascript") {
  if (typeof text !== "string" || text === "" || !lang) return [];
  try {
    const highlighter = await getHighlighter();
    const { tokens } = highlighter.codeToTokens(text, { lang, theme: "github-dark" });
    const flat = [];
    for (const line of tokens) {
      for (const token of line) {
        if (typeof token.offset !== "number" || token.content === "") continue;
        flat.push({ s: token.offset, e: token.offset + token.content.length, color: token.color });
      }
    }
    return flat;
  } catch {
    return [];
  }
}

/** 把 token 裁到 [from, to) 并平移成片段内坐标（与 clipMarks 同款） */
export function clipTokens(tokens, from, to) {
  const list = Array.isArray(tokens) ? tokens : [];
  const local = [];
  for (const token of list) {
    if (!token || typeof token.s !== "number" || typeof token.e !== "number") continue;
    if (token.e <= from || token.s >= to) continue;
    local.push({ s: Math.max(token.s, from) - from, e: Math.min(token.e, to) - from, color: token.color });
  }
  return local;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** mark 的类名与提示：与 highlights.js 那套一致（h=规则 / e=赋值 / v=变量） */
function markClass(mark) {
  const name = String(mark?.n ?? "");
  if (mark?.kind === "env") return mark.known === false ? "e e-u" : "e";
  if (mark?.kind === "var") return mark.known === false ? "v v-u" : "v";
  return "h";
}

/**
 * tokens + marks → HTML（纯函数）。
 *
 * 两类区间都当成"分段边界"处理，一趟扫完：每个字符要么带着颜色，要么带着标记，
 * 要么两者都有——这样语法颜色和审核标记互不挤掉对方。
 * marks 里带 kind（env/var）的用对应类名，其余按规则标记（h）。
 */
export function composeCodeHtml(text, tokens, marks) {
  const source = typeof text === "string" ? text : "";
  if (source === "") return "";
  const cuts = new Set([0, source.length]);
  const ranges = [];
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (!token || token.e <= token.s) continue;
    const s = Math.max(0, Math.min(token.s, source.length));
    const e = Math.max(0, Math.min(token.e, source.length));
    if (e <= s) continue;
    ranges.push({ s, e, color: token.color });
    cuts.add(s);
    cuts.add(e);
  }
  for (const mark of Array.isArray(marks) ? marks : []) {
    if (!mark || typeof mark.s !== "number" || typeof mark.e !== "number" || mark.e <= mark.s) continue;
    const s = Math.max(0, Math.min(mark.s, source.length));
    const e = Math.max(0, Math.min(mark.e, source.length));
    if (e <= s) continue;
    cuts.add(s);
    cuts.add(e);
  }
  const points = [...cuts].sort((a, b) => a - b);
  let html = "";
  for (let index = 0; index < points.length - 1; index++) {
    const from = points[index];
    const to = points[index + 1];
    if (to <= from) continue;
    const chunk = source.slice(from, to);
    const token = ranges.find((range) => range.s <= from && range.e >= to);
    const mark = (Array.isArray(marks) ? marks : []).find(
      (entry) => typeof entry?.s === "number" && entry.s <= from && entry.e >= to,
    );
    let piece = escapeHtml(chunk);
    if (token?.color) piece = `<span style="color:${token.color}">${piece}</span>`;
    if (mark) {
      const tip = escapeHtml(mark.t ?? "");
      piece = `<mark class="${markClass(mark)}" data-tip="${tip}">${piece}</mark>`;
    }
    html += piece;
  }
  return html;
}
