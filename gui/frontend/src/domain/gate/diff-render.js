// 对比行的渲染（纯函数）：转义、行内差异包一层、把一维行包成块。
//
// 行内差异来自 pi 侧的推演或前端的 lineDiff，坐标是片段内字符位置；
// 越界的区间一律夹回边界——渲染层不该因为越界抛错，那只会让整块内容看不见。

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 行内改动区间包成 <span class="intra">，其余原样转义 */
export function intraHtml(text, intra) {
  const source = typeof text === "string" ? text : "";
  const ranges = (Array.isArray(intra) ? intra : [])
    .filter((range) => range && typeof range.s === "number" && typeof range.e === "number")
    .map((range) => ({
      s: Math.max(0, Math.min(range.s, source.length)),
      e: Math.max(0, Math.min(range.e, source.length)),
    }))
    .filter((range) => range.e > range.s)
    .sort((a, b) => a.s - b.s);
  if (ranges.length === 0) return escapeHtml(source);
  let html = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.s < cursor) continue; // 重叠区间让位给前一个
    html += escapeHtml(source.slice(cursor, range.s));
    html += `<span class="intra">${escapeHtml(source.slice(range.s, range.e))}</span>`;
    cursor = range.e;
  }
  html += escapeHtml(source.slice(cursor));
  return html;
}

/** 一维行数组包成块（补丁视图这类没有 gap 的地方用） */
export function blocksOfRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.length === 0 ? [] : [{ type: "rows", rows: list }];
}

/** 行首符号：增删看得见，别的留空 */
export function signOf(kind) {
  if (kind === "add") return "+";
  if (kind === "del") return "-";
  return " ";
}

/** 行号栏：没有的留空（add 没有旧行号，del 没有新行号） */
export function gutterOf(row) {
  return {
    old: typeof row?.oldLine === "number" ? String(row.oldLine) : "",
    next: typeof row?.newLine === "number" ? String(row.newLine) : "",
  };
}
