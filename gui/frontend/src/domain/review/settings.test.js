// review/settings.test.js — 审核设置窗的表单逻辑
//
// 跑法：node --test src/domain/review/settings.test.js
//
// 这份用例的职责边界：前端校验只是「别让人白等一次往返」，权威校验在
// lib/review-settings.ts。所以用例盯两件事：
//   1 边界值与后端一致（0.05–0.99、1000–600000 毫秒、http(s)、枚举白名单）
//   2 序列化不偷改类型（数值必须是 number，noul 的 below 必须是 null）

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BACKENDS,
  FALLBACK_LIMITS,
  dimensionRows,
  errorLines,
  formFromSettings,
  limitsOf,
  patchFromForm,
  stepValue,
  summarizeChanges,
  validateForm,
} from "./settings.js";

const SETTINGS = {
  llm: { enabled: true, mode: "auto", backend: "chain", timeoutMs: 30000, tokenIdleMs: 4000, maxCache: 200 },
  classifier: { baseUrl: "https://api.siliconflow.cn", model: "diffusiongemma", timeoutMs: 3000 },
  dimensions: [
    { id: "elevation", enabled: true, above: 0.5, below: 0.5, action: "review" },
    { id: "scripted_edit", enabled: true, above: 0.5, below: null, action: "review" },
  ],
  warnings: [],
};

const SPECS = [
  { id: "elevation", label: "提权", type: "choice", supportsBelow: true, instructions: "是否提权" },
  { id: "scripted_edit", label: "脚本改写", type: "noul", supportsBelow: false, instructions: "是否脚本改写" },
];

describe("formFromSettings", () => {
  it("铺开三组字段，缺失时给保守默认值", () => {
    const form = formFromSettings(SETTINGS);
    assert.equal(form.llm.mode, "auto");
    assert.equal(form.llm.backend, "chain");
    assert.equal(form.llm.timeoutMs, 30000);
    assert.equal(form.classifier.model, "diffusiongemma");
    assert.equal(form.dimensions.length, 2);
    assert.equal(form.dimensions[1].below, null);

    const empty = formFromSettings({});
    assert.equal(empty.llm.enabled, true);
    assert.equal(empty.llm.timeoutMs, 30000);
    assert.equal(empty.classifier.baseUrl, "");
    assert.deepEqual(empty.dimensions, []);
  });

  it("不认的枚举值回落到安全档，不把未知值带进表单", () => {
    const form = formFromSettings({ llm: { mode: "yolo", backend: "both" } });
    assert.equal(form.llm.mode, "auto");
    assert.equal(form.llm.backend, "chat");
    assert.ok(BACKENDS.includes(form.llm.backend));
  });
});

describe("patchFromForm", () => {
  it("字段名与后端对齐，数值保持 number", () => {
    const form = formFromSettings(SETTINGS);
    form.llm.maxCache = "500";
    const patch = patchFromForm(form);
    assert.equal(patch.llm.maxCache, 500);
    assert.equal(typeof patch.llm.maxCache, "number");
    assert.equal(patch.llm.mode, "auto");
    assert.equal(patch.classifier.baseUrl, "https://api.siliconflow.cn");
    assert.deepEqual(patch.dimensions[1], { id: "scripted_edit", enabled: true, above: 0.5, below: null, action: "review" });
  });

  it("顺手 trim 字符串字段（粘贴常带空格）", () => {
    const form = formFromSettings(SETTINGS);
    form.classifier.baseUrl = "  https://example.com  ";
    form.classifier.model = " m1 ";
    const patch = patchFromForm(form);
    assert.equal(patch.classifier.baseUrl, "https://example.com");
    assert.equal(patch.classifier.model, "m1");
  });

  it("展示用的字段不会被提交（label / type / supportsBelow 留在前端）", () => {
    const form = formFromSettings(SETTINGS);
    dimensionRows(form, SPECS);
    const patch = patchFromForm(form);
    assert.deepEqual(Object.keys(patch.dimensions[0]).sort(), ["above", "action", "below", "enabled", "id"]);
  });
});

describe("validateForm", () => {
  it("合法配置零错误（含真实配置的形状）", () => {
    assert.deepEqual(validateForm(formFromSettings(SETTINGS), FALLBACK_LIMITS), []);
  });

  it("枚举白名单", () => {
    const form = formFromSettings(SETTINGS);
    form.llm.mode = "loose";
    form.llm.backend = "both";
    const errors = validateForm(form, FALLBACK_LIMITS);
    assert.ok(errors.some((e) => e.startsWith("档位：")));
    assert.ok(errors.some((e) => e.startsWith("审核后端：")));
  });

  it("数值区间越界与非法输入都点名字段", () => {
    const form = formFromSettings(SETTINGS);
    form.llm.timeoutMs = 10;
    form.llm.tokenIdleMs = "abc";
    form.llm.maxCache = 0.5;
    form.classifier.timeoutMs = 999999;
    const errors = validateForm(form, FALLBACK_LIMITS);
    assert.ok(errors.some((e) => e.includes("审核总时长兜底") && e.includes("1000–600000")));
    assert.ok(errors.some((e) => e.includes("相邻 token 间隔上限") && e.includes("需要数字")));
    assert.ok(errors.some((e) => e.includes("内存缓存上限")));
    assert.ok(errors.some((e) => e.includes("分类器超时") && e.includes("200–60000")));
  });

  it("端点必须是 http(s)，模型名不能带空白", () => {
    const form = formFromSettings(SETTINGS);
    form.classifier.baseUrl = "api.siliconflow.cn";
    form.classifier.model = "a b";
    let errors = validateForm(form, FALLBACK_LIMITS);
    assert.ok(errors.some((e) => e.includes("分类器端点") && e.includes("http://")));
    assert.ok(errors.some((e) => e.includes("分类器模型") && e.includes("空白")));

    form.classifier.baseUrl = "";
    form.classifier.model = "";
    errors = validateForm(form, FALLBACK_LIMITS);
    assert.ok(errors.some((e) => e.includes("分类器端点：不能为空")));
    assert.ok(errors.some((e) => e.includes("分类器模型：不能为空")));

    form.classifier.baseUrl = "https://";
    errors = validateForm(form, FALLBACK_LIMITS);
    assert.ok(errors.some((e) => e.includes("不是合法的 URL")));
  });

  it("维度阈值越界会被拦下；below=null 的维度不报错", () => {
    const form = formFromSettings(SETTINGS);
    form.dimensions[0].above = 1.2;
    form.dimensions[1].above = 0.4;
    const errors = validateForm(form, FALLBACK_LIMITS);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("维度 elevation above"));
  });

  it("limits 缺省时用兜底值（窗口拿不到 limits 也不至于放过越界）", () => {
    const form = formFromSettings(SETTINGS);
    form.llm.maxCache = 999999;
    assert.ok(validateForm(form, null).length > 0);
  });
});

describe("stepValue", () => {
  it("按步长增减并保留两位", () => {
    assert.equal(stepValue(0.5, 0.05, FALLBACK_LIMITS), 0.55);
    assert.equal(stepValue(0.3, 0.05, FALLBACK_LIMITS), 0.35);
    assert.equal(stepValue(0.35, -0.05, FALLBACK_LIMITS), 0.3);
  });

  it("夹在区间内（0 会让阈值永远触发，1 则永不触发）", () => {
    assert.equal(stepValue(0.05, -0.05, FALLBACK_LIMITS), 0.05);
    assert.equal(stepValue(0.99, 0.05, FALLBACK_LIMITS), 0.99);
    assert.equal(stepValue(Number.NaN, -0.05, FALLBACK_LIMITS), 0.05);
  });
});

describe("dimensionRows", () => {
  it("就地装饰：返回的就是表单里那几个对象，v-model 才写得回表单", () => {
    const form = formFromSettings(SETTINGS);
    const rows = dimensionRows(form, SPECS);
    assert.equal(rows[0], form.dimensions[0]);
    assert.equal(rows[0].label, "提权");
    assert.equal(rows[0].supportsBelow, true);
    assert.equal(rows[1].supportsBelow, false);
    assert.equal(rows[1].label, "脚本改写");
    // 元信息缺失时回落到 id，不让表格出现空白格
    const rowsNoSpec = dimensionRows(formFromSettings(SETTINGS), []);
    assert.equal(rowsNoSpec[0].label, "elevation");
  });
});

describe("limitsOf / errorLines / summarizeChanges", () => {
  it("limitsOf 用后端值覆盖兜底值", () => {
    const merged = limitsOf({ step: 0.1, aboveMin: 0.1 });
    assert.equal(merged.step, 0.1);
    assert.equal(merged.aboveMin, 0.1);
    assert.equal(merged.timeoutMsMax, FALLBACK_LIMITS.timeoutMsMax);
  });

  it("errorLines 优先用后端的 issues（中文逐条）", () => {
    assert.deepEqual(errorLines({ ok: false, issues: [{ field: "llm.mode", message: "只接受 auto / strict" }] }), [
      "llm.mode：只接受 auto / strict",
    ]);
    assert.deepEqual(errorLines({ ok: false, error: "桥脚本没有输出" }), ["桥脚本没有输出"]);
    assert.deepEqual(errorLines(null), ["保存失败：宿主没有返回结果"]);
  });

  it("summarizeChanges 说清改了几项以及旧新值", () => {
    assert.equal(summarizeChanges(["档位: auto → strict"]), "已保存 1 项：档位: auto → strict");
    assert.equal(summarizeChanges([]), "没有字段变化（值本来就一样）");
  });
});
