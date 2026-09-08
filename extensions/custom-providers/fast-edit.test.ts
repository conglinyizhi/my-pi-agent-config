import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_RELOAD_PROTECTION,
  ensureReloadProtection,
  fmtValue,
  formatWithSeparators,
  MODE_CHOICES,
  MODEL_FIELDS,
  numberPreview,
  parseNumberInput,
  reloadProtectionNotice,
  THINKING_FORMAT_CHOICES,
} from "./fast-edit.ts";

describe("fast-edit 字段展示", () => {
  it("do_not 显示为白话，而不是 remove / update", () => {
    assert.strictEqual(fmtValue(["remove", "update"]), "不删除 + 不覆盖");
    assert.strictEqual(fmtValue(["remove"]), "不删除");
    assert.strictEqual(fmtValue(["remove", "update", "edit"]), "不删除 + 不覆盖 + 禁止手动改");
  });

  it("其它数组、布尔、空值照旧", () => {
    assert.strictEqual(fmtValue(["text", "image"]), "text, image");
    assert.strictEqual(fmtValue(true), "开启");
    assert.strictEqual(fmtValue(false), "关闭");
    assert.strictEqual(fmtValue(undefined), "未设置");
    assert.strictEqual(fmtValue([]), "");
  });

  it("大整数顺带标出量级", () => {
    assert.strictEqual(fmtValue(1000000), "1000000（1.0M）");
    assert.strictEqual(fmtValue(384000), "384000（384K）");
    assert.strictEqual(fmtValue(4096), "4096");
    assert.strictEqual(fmtValue(0.242), "0.242");
  });

  it("保护行排在模型字段菜单第一行", () => {
    assert.strictEqual(MODEL_FIELDS[0].key, "do_not");
    assert.match(MODEL_FIELDS[0].label, /🛡/);
    assert.strictEqual(MODEL_FIELDS[0].path, "models[].do_not");
  });
});

describe("parseNumberInput", () => {
  it("直接写数字、下划线、逗号都认", () => {
    assert.strictEqual(parseNumberInput("1000000"), 1000000);
    assert.strictEqual(parseNumberInput("1_000_000"), 1000000);
    assert.strictEqual(parseNumberInput("1,000,000"), 1000000);
    assert.strictEqual(parseNumberInput(" 1 000 000 "), 1000000);
    assert.strictEqual(parseNumberInput("1，000，000"), 1000000);
  });

  it("K / M / B 与万 / 亿 后缀", () => {
    assert.strictEqual(parseNumberInput("1M"), 1000000);
    assert.strictEqual(parseNumberInput("1m"), 1000000);
    assert.strictEqual(parseNumberInput("512K"), 512000);
    assert.strictEqual(parseNumberInput("1.5M"), 1500000);
    assert.strictEqual(parseNumberInput("2B"), 2000000000);
    assert.strictEqual(parseNumberInput("100万"), 1000000);
    assert.strictEqual(parseNumberInput("1亿"), 100000000);
  });

  it("不带后缀时保留小数（价格要用）", () => {
    assert.strictEqual(parseNumberInput("0.242"), 0.242);
    assert.strictEqual(parseNumberInput("2.178"), 2.178);
    assert.strictEqual(parseNumberInput("2e-7"), 2e-7);
  });

  it("非法输入返回 null", () => {
    assert.strictEqual(parseNumberInput(""), null);
    assert.strictEqual(parseNumberInput("abc"), null);
    assert.strictEqual(parseNumberInput("-5"), null);
    assert.strictEqual(parseNumberInput("1M5"), null);
    assert.strictEqual(parseNumberInput("1x"), null);
  });
});

describe("选项式字段", () => {
  it("思考返回格式给的是候选值，覆盖 pi-ai 的全部 thinkingFormat", () => {
    const values = THINKING_FORMAT_CHOICES.map(c => c.value);
    assert.deepStrictEqual(values, [
      "openai",
      "deepseek",
      "openrouter",
      "together",
      "zai",
      "qwen",
      "qwen-chat-template",
      "chat-template",
      "string-thinking",
      "ant-ling",
    ]);
    const field = MODEL_FIELDS.find(f => f.key === "thinking_format")!;
    assert.strictEqual(field.kind, "choice");
    assert.strictEqual(field.choices?.length, THINKING_FORMAT_CHOICES.length);
  });

  it("输入模态是三选一 + 清除，不用手敲", () => {
    assert.deepStrictEqual(MODE_CHOICES.map(c => c.value), [["text"], ["text", "image"], ["image"], null]);
    const field = MODEL_FIELDS.find(f => f.key === "input")!;
    assert.strictEqual(field.kind, "modes");
  });
});

describe("数字预览", () => {
  it("加千位分隔符", () => {
    assert.strictEqual(formatWithSeparators(1000000), "1,000,000");
    assert.strictEqual(formatWithSeparators(384000), "384,000");
    assert.strictEqual(formatWithSeparators(1500), "1,500");
    assert.strictEqual(formatWithSeparators(999), "999");
    assert.strictEqual(formatWithSeparators(0.242), "0.242");
    assert.strictEqual(formatWithSeparators(2e-7), "2e-7");
  });

  it("输入 1M 就能看到 1,000,000", () => {
    assert.strictEqual(numberPreview("1M"), "1,000,000（1.0M）");
    assert.strictEqual(numberPreview("512K"), "512,000（512K）");
    assert.strictEqual(numberPreview("1_000_000"), "1,000,000（1.0M）");
    assert.strictEqual(numberPreview("100万"), "1,000,000（1.0M）");
    assert.strictEqual(numberPreview("4096"), "4,096");
    assert.strictEqual(numberPreview("0.242"), "0.242");
  });

  it("空输入不显示，非法输入与清除有提示", () => {
    assert.strictEqual(numberPreview("  "), null);
    assert.match(numberPreview("abc")!, /看不懂/);
    assert.match(numberPreview("清除")!, /清空/);
  });
});

describe("ensureReloadProtection", () => {
  it("没有配置时补上 remove + update", () => {
    const model: Record<string, unknown> = { id: "m" };
    assert.strictEqual(ensureReloadProtection(model), true);
    assert.deepStrictEqual(model.do_not, DEFAULT_RELOAD_PROTECTION);
  });

  it("空数组也算没配置", () => {
    const model: Record<string, unknown> = { id: "m", do_not: [] };
    assert.strictEqual(ensureReloadProtection(model), true);
    assert.deepStrictEqual(model.do_not, ["remove", "update"]);
  });

  it("已有任何 do_not 配置都不动", () => {
    const onlyEdit: Record<string, unknown> = { id: "m", do_not: ["edit"] };
    assert.strictEqual(ensureReloadProtection(onlyEdit), false);
    assert.deepStrictEqual(onlyEdit.do_not, ["edit"]);

    const already: Record<string, unknown> = { id: "m", do_not: ["remove", "update"] };
    assert.strictEqual(ensureReloadProtection(already), false);
  });

  it("提示文案说清 reload-online 不会再动它", () => {
    assert.match(reloadProtectionNotice("deepseek-v4-ft"), /reload-online/);
    assert.match(reloadProtectionNotice("deepseek-v4-ft"), /deepseek-v4-ft/);
  });
});
