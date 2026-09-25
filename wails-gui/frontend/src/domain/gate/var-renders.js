// 把 pi 侧算好的变量渲染结果（varRenders）转成命令预览的高亮条目与变量表行。
//
// 与 envNotes 的分工：envNotes 说的是「这条命令自己声明的赋值解析成什么」，由 pi 侧
// 直接给出 start/end；varRenders 说的是「命令里用到的变量渲染成什么」，只给一段
// target 文本，没有偏移——定位要在前端做。
//
// 形状：{name, value?, source: "assignment"|"env", target, kind, known, reason?}
// tone: var（蓝，渲染值已知） / var-unknown（灰，解析不了，文案里带原因）

/** 条数上限与 pi 侧一致；超出只当前 20 条，不整块丢掉 */
export const VAR_RENDER_LIMIT = 20;

const SOURCE_LABELS = { assignment: "命令内赋值", env: "环境变量" };

// 标识符形态的 target（P / $P / PATH 这种）才做词边界检查：不然 $P 会在 $PATH 里
// 命中、PATH 会在 PATH_EXTRA 里命中，画出一堆假框。带 $( ... ) 之类的片段按原文匹配。
const IDENT_TARGET = /^\$?[A-Za-z_][A-Za-z0-9_]*$/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

function isBoundaryClear(text, index, target) {
  if (!IDENT_TARGET.test(target)) return true;
  const after = text[index + target.length];
  if (after !== undefined && IDENT_CHAR.test(after)) return false;
  if (target.startsWith("$")) return true;
  const before = index > 0 ? text[index - 1] : undefined;
  return !(before !== undefined && IDENT_CHAR.test(before));
}

function occurrences(text, target) {
  const found = [];
  if (!target) return found;
  let index = text.indexOf(target);
  while (index !== -1) {
    if (isBoundaryClear(text, index, target)) found.push(index);
    index = text.indexOf(target, index + target.length);
  }
  return found;
}

function normalize(list) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item === "object")
    .slice(0, VAR_RENDER_LIMIT)
    .map((item, index) => {
      const name = typeof item.name === "string" ? item.name : "";
      const value = typeof item.value === "string" ? item.value : "";
      const source = item.source === "env" ? "env" : "assignment";
      return {
        key: `${index}:${name}`,
        name,
        target: typeof item.target === "string" ? item.target : "",
        // 有值就当渲染出来了（老 payload 可能没有 known 字段）；known:false 一律按解析不了
        known: item.known !== false && typeof item.value === "string",
        value,
        source,
        sourceLabel: SOURCE_LABELS[source],
        kind: typeof item.kind === "string" ? item.kind : "",
        reason: typeof item.reason === "string" ? item.reason : "",
      };
    });
}

function tipOf(entry) {
  if (entry.known) return `${entry.name} = ${entry.value}（${entry.sourceLabel}）`;
  return `${entry.name}：解析不了（${entry.reason || "原因不明"}）`;
}

/** 变量表行：一条 varRenders 一行，known:false 的带原因、不带值 */
export function varRenderRows(varRenders) {
  return normalize(varRenders);
}

/** 命令预览的高亮条目：把每条 target 在命令文本里定位（可能多处），给出 s/e/t/tone */
export function varRenderHighlights(command, varRenders) {
  const text = typeof command === "string" ? command : "";
  const list = [];
  for (const entry of normalize(varRenders)) {
    // 没有 target 就没有可定位的文本：只进行，不画框（宁可不标，不标错位置）
    if (!entry.target) continue;
    for (const start of occurrences(text, entry.target)) {
      list.push({ s: start, e: start + entry.target.length, t: tipOf(entry), tone: entry.known ? "var" : "var-unknown" });
    }
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

/**
 * 三类高亮合成一条有序列表：规则命中 > 命令内赋值（envNotes）> 变量渲染值。
 *
 * 变量渲染值排在最后是故意的：赋值那一格 envNotes 已经给出了同样的值，再叠一层
 * 蓝框只会把绿色盖掉；规则是安全信号，任何时候都优先。
 */
export function mergeVarHighlights(varHighlights, keepHighlights) {
  const keep = Array.isArray(keepHighlights) ? keepHighlights : [];
  const kept = (Array.isArray(varHighlights) ? varHighlights : []).filter(
    (item) => !keep.some((other) => item.s < other.e && other.s < item.e),
  );
  return [...keep, ...kept].sort((a, b) => a.s - b.s || a.e - b.e);
}
