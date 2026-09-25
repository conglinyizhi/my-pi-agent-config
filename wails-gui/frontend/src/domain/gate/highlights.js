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
    // 规则命中用 mark.h（导航与红色高亮都挂它）；赋值解析用 mark.e（绿=已解析 / 灰=解析不了）。
    // 两者不能混用同一个类：导航按 mark.h 数序号，混起来就会指错。
    const cls = highlight.tone === "env" ? "e" : highlight.tone === "env-unknown" ? "e e-u" : "h";
    html += escapeText(text.slice(position, highlight.s));
    html += `<mark class="${cls}" data-i="${index}" data-tip="${escapeAttribute(highlight.t)}">${escapeText(text.slice(highlight.s, highlight.e))}</mark>`;
    position = highlight.e;
  }
  return html + escapeText(text.slice(position));
}

/**
 * 合并两类高亮：规则命中优先，与它重叠的赋值高亮丢掉。
 *
 * 重叠时保规则那一侧是故意的：规则是安全信号（rm-recursive 那种），
 * 赋值解析只是参考；两者叠在一段文本上会把语义搞溦。
 */
export function mergeEnvHighlights(envHighlights, ruleHighlights) {
  const rules = Array.isArray(ruleHighlights) ? ruleHighlights : [];
  const kept = (Array.isArray(envHighlights) ? envHighlights : []).filter(
    (env) => !rules.some((rule) => env.s < rule.e && rule.s < env.e),
  );
  return [...kept, ...rules].sort((a, b) => a.s - b.s || a.e - b.e);
}

export function isPathCovered(path, roots) {
  return (Array.isArray(roots) ? roots : []).some((root) => path === root || path.startsWith(`${root}/`));
}

export function pathTrustState(path, { persistentRoots, sessionTrustedRoots, sessionWriteRoots, builtinRoots, workspaceRoot } = {}) {
  if (isPathCovered(path, builtinRoots)) {
    if (workspaceRoot && (path === workspaceRoot || path.startsWith(`${workspaceRoot}/`))) return "工作区可写";
    return "已放行";
  }
  if (isPathCovered(path, persistentRoots)) return "长期信任";
  if (isPathCovered(path, sessionTrustedRoots)) return "本 session 信任";
  if (isPathCovered(path, sessionWriteRoots)) return "本 session 可写";
  return "本次新增";
}
