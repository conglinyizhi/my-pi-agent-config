// 补丁正文 → 展示用的行（纯函数）。
//
// apply_patch / patch 交上来的**本来就是一份 diff**，所以这里不做任何对比计算：
// 认出行首的 +/-/@ 就够了，改了什么全在原文里。认不出来的行照实摆（它多半是
// 头部说明，比如 *** Begin Patch 或 "*** End Patch"），别丢。

/**
 * 行类型：
 *   meta  = 补丁头部 / hunk 头 / 说明行
 *   add   = 新增（+）
 *   del   = 删除（-）
 *   context = 上下文（空格开头）
 */
export function patchToRows(patchText) {
  const text = typeof patchText === "string" ? patchText : "";
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rows = [];
  let oldLine;
  let newLine;
  for (const line of lines) {
    if (line === "") continue; // 空行在补丁视图里没有信息，别占一行
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "meta", text: line });
      continue;
    }
    // 文件头只在上一条也是头部/说明时才认：进了 hunk 之后，首字符说了算
    // （否则 hunk 里一行以 "-- " 开头的内容会被误当成文件头）
    const previous = rows[rows.length - 1];
    const looksLikeFileHeader = (line.startsWith("--- ") || line.startsWith("+++ ")) && (!previous || previous.kind === "meta");
    if (looksLikeFileHeader) {
      rows.push({ kind: "meta", text: line });
      continue;
    }
    const head = line[0];
    if (head === "+") {
      rows.push({ kind: "add", text: line.slice(1), ...(newLine === undefined ? {} : { newLine }) });
      if (newLine !== undefined) newLine += 1;
    } else if (head === "-") {
      rows.push({ kind: "del", text: line.slice(1), ...(oldLine === undefined ? {} : { oldLine }) });
      if (oldLine !== undefined) oldLine += 1;
    } else if (head === " ") {
      rows.push({
        kind: "context",
        text: line.slice(1),
        ...(oldLine === undefined ? {} : { oldLine }),
        ...(newLine === undefined ? {} : { newLine }),
      });
      if (oldLine !== undefined) oldLine += 1;
      if (newLine !== undefined) newLine += 1;
    } else {
      rows.push({ kind: "meta", text: line });
    }
  }
  return rows;
}

/** 补丁里被删/加的行数（摆个规模给人看） */
export function patchCounts(rows) {
  let added = 0;
  let removed = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.kind === "add") added += 1;
    if (row.kind === "del") removed += 1;
  }
  return { added, removed };
}
