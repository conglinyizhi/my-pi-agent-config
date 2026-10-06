// 脚本事前审核（PTC / run_code）在审批窗里的呈现。
//
// pi 侧已经把影响面算成结构化的（tools / paths / commands / opaque / parseError），
// 这里只负责把它整理成分区数据，交给 Vue 摆。放 domain 是因为这一段纯函数，
// 可以用 node --test 直接测（见 script-audit.test.js）。

/** 这份请求是不是脚本事前审核 */
export function isScriptAudit(data) {
  return Boolean(data) && data.subject === "script";
}

/** 窗口标题：脚本审核换一个，别跟"危险命令审计"混 */
export function scriptAuditTitle() {
  return "🧩 脚本事前审核 · run_code";
}

/**
 * 规范化视图（pi 侧 ptc-canon 的产出一份）：常量已经内联回使用处的那份脚本。
 *
 * 审核模型看的就是这一份，人也该看得到同一份——否则会出现"模型说路径是 /x，
 * 窗口里显示的却是变量 p"这种对不上的场面。没得改或校验没过时 pi 不发这个字段，
 * 这里返回 null，窗口就整块不渲染。
 */
export function canonViewOf(scriptCanon) {
  if (!scriptCanon || typeof scriptCanon.code !== "string" || !scriptCanon.code.trim()) return null;
  const inlined = Array.isArray(scriptCanon.inlined)
    ? scriptCanon.inlined.filter((name) => typeof name === "string" && name.trim())
    : [];
  return {
    code: scriptCanon.code,
    label: inlined.length > 0 ? `✨ 规范化视图（内联了 ${inlined.join("、")}）` : "✨ 规范化视图",
    note: "执行体仍是原脚本；这一份只是把字面量常量搬回使用处，语义没变",
  };
}

const MAX_ITEMS = 12;

function cleanItems(items) {
  const list = (Array.isArray(items) ? items : []).filter((item) => typeof item === "string" && item.trim().length > 0);
  if (list.length <= MAX_ITEMS) return list;
  return [...list.slice(0, MAX_ITEMS), `…（还有 ${list.length - MAX_ITEMS} 条）`];
}

/**
 * 影响面分区。空的分区不返回；`warn` 标记的是"看不清/有问题"那两档，
 * 它们在窗口里要显眼一些——那是人真正该看的地方。
 */
export function effectSectionsOf(effects) {
  if (!effects || typeof effects !== "object") return [];
  const sections = [];
  const push = (key, label, items, warn = false) => {
    const list = cleanItems(items);
    if (list.length > 0) sections.push({ key, label, items: list, warn });
  };
  // 干跑是"假数据走了一遍控制流"的结果，比字面量更接近真实，放最前
  if (Array.isArray(effects.dryRunCalls) && effects.dryRunCalls.length > 0) {
    const suffix = effects.dryRunStatus === "ok" ? "" : `（${effects.dryRunStatus === "timeout" ? "预演超时" : "预演失败"}，可能不全）`;
    sections.push({ key: "dryrun", label: `干跑预演会执行${suffix}`, items: cleanItems(effects.dryRunCalls), warn: effects.dryRunStatus !== "ok" });
  }
  push("tools", "字面上调用的工具", effects.tools);
  push("paths", "路径字面量", effects.paths);
  // 「命令字面量」那行删了：它是一条不换行、不着色的长字符串，读不出东西；
  // 命令本身在 shell 芯片的弹窗里（PWD / shell(bash) / PreShell）已经摆得清楚得多
  push("opaque", "看不清的地方（值由运行时决定，实际可能更多）", effects.opaque, true);
  push("parseError", "语法问题", effects.parseError ? [String(effects.parseError)] : [], true);
  return sections;
}

/** 摘要那一行：批准只对这一段脚本生效，把短摘要摆出来给人事后对账 */
export function digestLine(effects) {
  const short = effects && typeof effects.digestShort === "string" ? effects.digestShort : "";
  return short ? `脚本摘要 ${short}（批准只对这一段生效）` : "";
}
