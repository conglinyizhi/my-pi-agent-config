// Gate 命令高亮的纯逻辑：不依赖 Vue、DOM 或 Wails，可被浏览器壳复用。

export function findHighlights(command, rules) {
  const text = typeof command === "string" ? command : "";
  const found = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    for (const token of Array.isArray(rule?.matched) ? rule.matched : []) {
      if (typeof token !== "string" || token.length === 0) continue;
      let index = 0;
      while ((index = text.indexOf(token, index)) !== -1) {
        found.push({ s: index, e: index + token.length, t: rule.tip || "", n: rule.name || "" });
        index += token.length;
      }
    }
  }
  found.sort((a, b) => a.s - b.s || a.e - b.e);

  const merged = [];
  for (const highlight of found) {
    const last = merged[merged.length - 1];
    const sameRule = last && last.n === highlight.n;
    if (last && (sameRule || highlight.s <= last.e) &&
      (highlight.s <= last.e || /^\s*$/.test(text.slice(last.e, highlight.s)))) {
      last.e = Math.max(last.e, highlight.e);
    } else {
      merged.push({ ...highlight });
    }
  }
  return merged;
}

function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function renderHighlightedCommand(command, highlights) {
  const text = typeof command === "string" ? command : "";
  const list = Array.isArray(highlights) ? highlights : [];
  let html = "";
  let position = 0;
  for (let index = 0; index < list.length; index++) {
    const highlight = list[index];
    html += escapeText(text.slice(position, highlight.s));
    html += `<mark class="h" data-i="${index}" data-tip="${escapeAttribute(highlight.t)}">${escapeText(text.slice(highlight.s, highlight.e))}</mark>`;
    position = highlight.e;
  }
  return html + escapeText(text.slice(position));
}

export function isPathCovered(path, roots) {
  return (Array.isArray(roots) ? roots : []).some((root) => path === root || path.startsWith(`${root}/`));
}

export function pathTrustState(path, { persistentRoots, sessionTrustedRoots, sessionWriteRoots }) {
  if (isPathCovered(path, persistentRoots)) return "长期信任";
  if (isPathCovered(path, sessionTrustedRoots)) return "本 session 信任";
  if (isPathCovered(path, sessionWriteRoots)) return "本 session 可写";
  return "本次新增";
}
