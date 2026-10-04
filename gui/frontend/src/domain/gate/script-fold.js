// 脚本预览的折叠模型：把"会改状态的调用"折成芯片，其余按原文摆。
// 纯逻辑，不碰 Vue/DOM——跟 highlights.js 一样能被别的壳复用，也能单测。
//
// 只认 pi 侧给的事实（editCalls）：哪个区间要折、折成什么标签、路径缩成什么。
// 前端不猜：拿不到记录就一行不折，原文照出。

/**
 * 芯片的落点标签：文件编辑给路径，bash 给 $$SHELL$$（那是"这里是一段可执行 shell"）。
 * 工具名补回 tools. 前缀：pi 侧记录的是裸名（write / bash），而脚本里写的是 tools.write。
 */
function qualify(tool) {
  const name = typeof tool === "string" && tool !== "" ? tool : "?";
  return name.includes(".") ? name : `tools.${name}`;
}

function labelOf(call) {
  const path = typeof call.displayPath === "string" && call.displayPath !== "" ? call.displayPath : "…";
  const name = qualify(call.tool);
  if (call.kind === "shell") {
    return call.displayPath ? `${name}($$SHELL$$, cwd=${call.displayPath})` : `${name}($$SHELL$$)`;
  }
  return `${name}(${path})`;
}

/**
 * 收回来的记录先过一遍体检：
 *   - 区间必须落在脚本文本里，且非空
 *   - 完全包在另一个调用里的丢掉（内层调用自己也是芯片的话，UI 没地方摆）
 * 顺序按起点排，同一层不允许重叠。
 */
export function normalizeFoldCalls(script, editCalls) {
  const text = typeof script === "string" ? script : "";
  const list = Array.isArray(editCalls) ? editCalls : [];
  const valid = [];
  for (const call of list) {
    if (!call || typeof call !== "object") continue;
    const start = call.startOffset;
    const end = call.endOffset;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end > text.length || end <= start) continue;
    valid.push(call);
  }
  valid.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  const kept = [];
  for (const call of valid) {
    const last = kept[kept.length - 1];
    if (last && call.endOffset <= last.endOffset) continue; // 落在上一颗里
    kept.push(call);
  }
  return kept;
}

/**
 * 生成预览片段。
 *
 * marks 用全局坐标（跟 highlights.js 的 { s, e, t, n } 一致）；返回的每个 text
 * 片段里的 marks 已经裁剪并平移成**片段内坐标**，可以直接交给 renderHighlightedCommand。
 * 被折进芯片内部的 mark 不会消失——它们记在 chips[i].hiddenMarks 里，
 * 导航跳到那儿时由芯片负责把它露出来（折叠不是"看不到"，是"先不看"）。
 */
export function foldScript(script, editCalls, marks = [], options = {}) {
  const text = typeof script === "string" ? script : "";
  const callList = normalizeFoldCalls(text, editCalls);
  const markList = Array.isArray(marks) ? marks : [];
  const warnMarks = Array.isArray(options.warnMarks) ? options.warnMarks : [];

  const chips = callList.map((call, index) => ({
    index,
    call,
    label: labelOf(call),
    tone: call.kind === "shell" ? "shell" : "file",
    literal: call.literal !== false,
    hiddenMarks: [],
    warned: false,
  }));

  // mark 归属：与哪个调用区间相交就算谁的（跨边界的 mark 两边都算：
  // 芯片上挂个标记，可视片段里也保留外侧那截，导航才不会指到看不见的地方）
  const markOwner = markList.map((mark) => {
    if (!mark || typeof mark.s !== "number" || typeof mark.e !== "number") return -1;
    return callList.findIndex((call) => mark.s < call.endOffset && mark.e > call.startOffset);
  });
  markOwner.forEach((owner, index) => {
    if (owner < 0) return;
    const chip = chips[owner];
    chip.hiddenMarks.push(index);
    if (warnMarks.includes(markList[index])) chip.warned = true;
  });

  const segments = [];
  const pushText = (from, to) => {
    if (to <= from) return;
    const local = [];
    for (const mark of markList) {
      if (!mark || typeof mark.s !== "number" || typeof mark.e !== "number") continue;
      if (mark.e <= from || mark.s >= to) continue;
      local.push({ ...mark, s: Math.max(mark.s, from) - from, e: Math.min(mark.e, to) - from });
    }
    segments.push({ kind: "text", text: text.slice(from, to), start: from, end: to, marks: local });
  };

  let cursor = 0;
  callList.forEach((call, index) => {
    pushText(cursor, call.startOffset);
    segments.push({ kind: "chip", chip: chips[index], start: call.startOffset, end: call.endOffset });
    cursor = call.endOffset;
  });
  pushText(cursor, text.length);

  return { segments, chips, markOwner };
}

/** 哪个芯片盖住了这条 mark（导航跳到被折住的高亮时，用它找该弹哪颗） */
export function chipIndexOfMark(model, markIndex) {
  const owner = model?.markOwner?.[markIndex];
  return typeof owner === "number" && owner >= 0 ? owner : -1;
}
