// review/settings.js — 审核设置窗的表单纯逻辑（不依赖 Vue / DOM / 宿主）
//
// 放这里而不是 .vue 里，有两个理由：
//   1 node --test 能直接测（校验规则与序列化是这次最容易出错的地方）；
//   2 后端（lib/review-settings.ts）才是权威校验，前端这份是「别让人白等一次往返」的门槛，
//      所以两边的边界值必须一致——一致性靠这份用例钉住，而不是靠人记得。
//
// 约定：所有文案中文；错误信息说清哪个字段、为什么不接受。

/** 与后端 REVIEW_LIMITS 同形的兜底值（窗口拿不到 limits 时用；正常应随 initData 下来） */
export const FALLBACK_LIMITS = {
  step: 0.05,
  aboveMin: 0.05,
  aboveMax: 0.99,
  belowMin: 0.05,
  belowMax: 0.99,
  timeoutMsMin: 1000,
  timeoutMsMax: 600000,
  tokenIdleMsMin: 200,
  tokenIdleMsMax: 60000,
  maxCacheMin: 1,
  maxCacheMax: 100000,
  classifierTimeoutMsMin: 200,
  classifierTimeoutMsMax: 60000,
};

export const MODES = ["auto", "strict"];
export const BACKENDS = ["chat", "classifier", "chain"];
export const ACTIONS = ["review", "ignore"];

export function limitsOf(raw) {
  return { ...FALLBACK_LIMITS, ...(raw || {}) };
}

/** 后端设置 → 表单状态（表单里数值保持 number，字符串字段保持 string） */
export function formFromSettings(settings) {
  const llm = settings?.llm || {};
  const classifier = settings?.classifier || {};
  return {
    llm: {
      enabled: llm.enabled !== false,
      mode: llm.mode === "strict" ? "strict" : "auto",
      backend: BACKENDS.includes(llm.backend) ? llm.backend : "chat",
      timeoutMs: numOr(llm.timeoutMs, 30000),
      tokenIdleMs: numOr(llm.tokenIdleMs, 4000),
      maxCache: numOr(llm.maxCache, 200),
    },
    classifier: {
      baseUrl: typeof classifier.baseUrl === "string" ? classifier.baseUrl : "",
      model: typeof classifier.model === "string" ? classifier.model : "",
      timeoutMs: numOr(classifier.timeoutMs, 3000),
    },
    dimensions: (settings?.dimensions || []).map((dim) => ({
      id: String(dim.id),
      enabled: dim.enabled !== false,
      above: numOr(dim.above, 0.5),
      below: dim.below === null || dim.below === undefined ? null : numOr(dim.below, 0.5),
      action: dim.action === "ignore" ? "ignore" : "review",
    })),
  };
}

function numOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 表单状态 → 提交给后端的 patch（只发这一份，字段名与 lib/review-settings.ts 对齐） */
export function patchFromForm(form) {
  return {
    llm: {
      enabled: Boolean(form.llm.enabled),
      mode: form.llm.mode,
      backend: form.llm.backend,
      timeoutMs: toNumber(form.llm.timeoutMs),
      tokenIdleMs: toNumber(form.llm.tokenIdleMs),
      maxCache: toNumber(form.llm.maxCache),
    },
    classifier: {
      baseUrl: String(form.classifier.baseUrl || "").trim(),
      model: String(form.classifier.model || "").trim(),
      timeoutMs: toNumber(form.classifier.timeoutMs),
    },
    dimensions: (form.dimensions || []).map((dim) => ({
      id: dim.id,
      enabled: Boolean(dim.enabled),
      above: toNumber(dim.above),
      // noul 维度没有置信度：below 只能是 null，别把占位的 0.5 当成配置写回去
      below: dim.below === null || dim.below === undefined ? null : toNumber(dim.below),
      action: dim.action,
    })),
  };
}

function toNumber(value) {
  if (typeof value === "number") return value;
  const parsed = Number(String(value ?? "").trim());
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/**
 * 表单自检。返回中文错误行（空数组 = 可以提交）。
 * 规则与后端一致：枚举白名单、数值区间、base_url 必须 http(s)、模型名不能带空白。
 */
export function validateForm(form, rawLimits) {
  const limits = limitsOf(rawLimits);
  const errors = [];
  const checkRange = (label, value, min, max, unit) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${label}：需要数字`);
      return;
    }
    if (value < min || value > max) errors.push(`${label}：需要在 ${min}–${max} 之间${unit ? `（${unit}）` : ""}，当前 ${value}`);
  };

  if (!MODES.includes(form.llm.mode)) errors.push(`档位：只接受 ${MODES.join(" / ")}`);
  if (!BACKENDS.includes(form.llm.backend)) errors.push(`审核后端：只接受 ${BACKENDS.join(" / ")}`);
  checkRange("审核总时长兜底", toNumber(form.llm.timeoutMs), limits.timeoutMsMin, limits.timeoutMsMax, "毫秒");
  checkRange("相邻 token 间隔上限", toNumber(form.llm.tokenIdleMs), limits.tokenIdleMsMin, limits.tokenIdleMsMax, "毫秒");
  checkRange("内存缓存上限", toNumber(form.llm.maxCache), limits.maxCacheMin, limits.maxCacheMax, "");
  checkRange("分类器超时", toNumber(form.classifier.timeoutMs), limits.classifierTimeoutMsMin, limits.classifierTimeoutMsMax, "毫秒");

  const baseUrl = String(form.classifier.baseUrl || "").trim();
  if (!baseUrl) errors.push("分类器端点：不能为空（形如 https://api.siliconflow.cn）");
  else if (!/^https?:\/\//i.test(baseUrl)) errors.push(`分类器端点：只接受 http:// 或 https:// 开头，当前“${baseUrl}”`);
  else {
    try {
      new URL(baseUrl);
    } catch {
      errors.push(`分类器端点：不是合法的 URL：“${baseUrl}”`);
    }
  }

  const model = String(form.classifier.model || "").trim();
  if (!model) errors.push("分类器模型：不能为空");
  else if (/\s/.test(model)) errors.push(`分类器模型：不能带空白字符（“${model}”）`);
  else if (model.length > 200) errors.push(`分类器模型：名字过长（${model.length} 字符，上限 200）`);

  for (const dim of form.dimensions || []) {
    const label = `维度 ${dim.id}`;
    if (!ACTIONS.includes(dim.action)) errors.push(`${label}：动作只接受 ${ACTIONS.join(" / ")}`);
    checkRange(`${label} above`, toNumber(dim.above), limits.aboveMin, limits.aboveMax, "");
    if (dim.below !== null && dim.below !== undefined) {
      checkRange(`${label} below`, toNumber(dim.below), limits.belowMin, limits.belowMax, "");
    }
  }
  return errors;
}

/** 阈值步进：夹在范围内、保留两位（浮点尾巴不累积） */
export function stepValue(value, delta, rawLimits) {
  const limits = limitsOf(rawLimits);
  const base = typeof value === "number" && Number.isFinite(value) ? value : limits.aboveMin;
  const next = Math.round((base + delta) * 100) / 100;
  return Math.max(limits.aboveMin, Math.min(limits.aboveMax, next));
}

/**
 * 维度行：把维度元信息（label / type / supportsBelow / instructions）并到表单行上。
 *
 * 刻意**就地装饰**、不拷贝：返回的就是 form.dimensions 里那几个对象，
 * 模板上的 v-model="row.enabled" 才会写回表单（拷贝一份的话改的是副本）。
 * patchFromForm 只取它自己那份字段名，多出来的展示字段不会跟着提交。
 */
export function dimensionRows(form, specs) {
  const byId = new Map((specs || []).map((spec) => [spec.id, spec]));
  return (form.dimensions || []).map((dim) => {
    const spec = byId.get(dim.id) || {};
    dim.label = spec.label || dim.id;
    dim.type = spec.type || "";
    dim.supportsBelow = spec.supportsBelow === true;
    dim.instructions = spec.instructions || "";
    return dim;
  });
}

/** 后端返回的失败结果 → 展示用文本（issues 优先，其次 error） */
export function errorLines(response) {
  if (!response) return ["保存失败：宿主没有返回结果"];
  if (Array.isArray(response.issues) && response.issues.length > 0) {
    return response.issues.map((issue) => (issue.field ? `${issue.field}：${issue.message}` : issue.message));
  }
  if (typeof response.error === "string" && response.error) return [response.error];
  return ["保存失败：原因未给出"];
}

/** 变更列表 → 一行摘要（“已保存：mode: auto → strict”） */
export function summarizeChanges(changed) {
  if (!Array.isArray(changed) || changed.length === 0) return "没有字段变化（值本来就一样）";
  return `已保存 ${changed.length} 项：${changed.join("；")}`;
}
