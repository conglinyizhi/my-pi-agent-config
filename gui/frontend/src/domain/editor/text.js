// 提示词编辑的纯文本变换：选区位置由宿主 DOM 提供，变换本身可在浏览器或测试中复用。

export function normalizeTagName(tag) {
  return typeof tag === "string" ? tag.trim().replace(/[<>]/g, "") : "";
}

export function insertTextAtSelection(text, insertion, start = 0, end = start) {
  const source = typeof text === "string" ? text : "";
  const value = typeof insertion === "string" ? insertion : "";
  const safeStart = Math.max(0, Math.min(start, source.length));
  const safeEnd = Math.max(safeStart, Math.min(end, source.length));
  const next = source.slice(0, safeStart) + value + source.slice(safeEnd);
  const cursor = safeStart + value.length;
  return { text: next, selectionStart: cursor, selectionEnd: cursor };
}

export function insertTagAtSelection(text, tag, start = 0, end = start) {
  const source = typeof text === "string" ? text : "";
  const name = normalizeTagName(tag);
  if (!name) return { text: source, selectionStart: start, selectionEnd: end, changed: false };
  const safeStart = Math.max(0, Math.min(start, source.length));
  const safeEnd = Math.max(safeStart, Math.min(end, source.length));
  if (safeStart !== safeEnd) {
    const selected = source.slice(safeStart, safeEnd);
    const wrapped = `<${name}>${selected}</${name}>`;
    const next = source.slice(0, safeStart) + wrapped + source.slice(safeEnd);
    const cursor = safeStart + wrapped.length;
    return { text: next, selectionStart: cursor, selectionEnd: cursor, changed: true };
  }
  const inner = "\n\n";
  const insertion = `<${name}>${inner}</${name}>`;
  const next = source.slice(0, safeStart) + insertion + source.slice(safeEnd);
  const innerStart = safeStart + name.length + 2;
  return { text: next, selectionStart: innerStart, selectionEnd: innerStart + inner.length, changed: true };
}

export function historyPreview(text, limit = 60) {
  return typeof text === "string" ? text.slice(0, limit).replace(/\n/g, " ") : "";
}
