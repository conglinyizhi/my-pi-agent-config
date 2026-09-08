import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_RELOAD_PROTECTION,
  ensureReloadProtection,
  fmtValue,
  MODEL_FIELDS,
  reloadProtectionNotice,
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

  it("保护行排在模型字段菜单第一行", () => {
    assert.strictEqual(MODEL_FIELDS[0].key, "do_not");
    assert.match(MODEL_FIELDS[0].label, /🛡/);
    assert.strictEqual(MODEL_FIELDS[0].path, "models[].do_not");
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
