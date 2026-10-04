// 把 pi 侧算好的赋值解析结果（envNotes）转成命令预览的高亮条目。
//
// 这里不做解析：值是在 pi 进程那侧按 shell 规则展开的（那才是命令真拿到的环境）。
// 前端只负责把坐标、颜色、悬停文案摆好。
//
// tone: env（绿，解析出来了） / env-unknown（灰，没解析出来，文案里带原因）

export function envNoteHighlights(command, notes) {
  const text = typeof command === "string" ? command : "";
  const list = [];
  for (const note of Array.isArray(notes) ? notes : []) {
    const start = Number(note?.start);
    const end = Number(note?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end <= start || end > text.length) continue;
    const name = typeof note?.name === "string" ? note.name : "";
    const hasValue = typeof note?.value === "string";
    const tip = hasValue
      ? `${name} = ${note.value}`
      : `${name}：解析不了（${typeof note?.reason === "string" ? note.reason : "原因不明"}）`;
    list.push({ s: start, e: end, t: tip, tone: hasValue ? "env" : "env-unknown" });
  }
  list.sort((a, b) => a.s - b.s || a.e - b.e);
  const merged = [];
  for (const item of list) {
    const last = merged[merged.length - 1];
    if (last && item.s < last.e) continue; // 自己跟自己重叠：丢掉后面的，保持偏移单调
    merged.push(item);
  }
  return merged;
}
