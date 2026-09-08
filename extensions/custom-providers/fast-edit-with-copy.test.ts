import assert from "node:assert";
import { describe, it } from "node:test";
import {
  buildCopiedModel,
  collectModelEntries,
  describeModelFields,
  filterModelEntries,
  parseCopyArgs,
} from "./fast-edit-with-copy.ts";

const SOURCE = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  context_window: 1000000,
  max_tokens: 384000,
  cost_input: 0.242,
  cost_output: 0.726,
  reasoning: true,
  input: ["text", "image"],
  cost_locked: true,
  do_not: ["remove", "edit"],
  cot_replay: true,
  compat: { force_adaptive_thinking: true },
};

describe("fast-edit-with-copy", () => {
  it("parses positional args in target / source / new-id order", () => {
    assert.deepStrictEqual(parseCopyArgs("tokenflux deepseek-v4-flash v4-ft-test"), {
      targetQuery: "tokenflux",
      sourceQuery: "deepseek-v4-flash",
      newId: "v4-ft-test",
    });
    assert.deepStrictEqual(parseCopyArgs("  "), { targetQuery: "", sourceQuery: "", newId: "" });
    assert.deepStrictEqual(parseCopyArgs("tokenflux，deepseek"), {
      targetQuery: "tokenflux",
      sourceQuery: "deepseek",
      newId: "",
    });
  });

  it("copies every field except id / name / do_not / cost_locked", () => {
    const copied = buildCopiedModel(SOURCE, "deepseek-v4-ft-test");

    assert.deepStrictEqual(Object.keys(copied), [
      "id",
      "context_window",
      "max_tokens",
      "cost_input",
      "cost_output",
      "reasoning",
      "input",
      "cot_replay",
      "compat",
    ]);
    assert.strictEqual(copied.id, "deepseek-v4-ft-test");
    assert.strictEqual(copied.name, undefined);
    assert.strictEqual(copied.cost_locked, undefined);
    assert.strictEqual(copied.do_not, undefined);
    assert.strictEqual(copied.context_window, 1000000);
  });

  it("deep-clones nested compat / arrays so the source stays untouched", () => {
    const copied = buildCopiedModel(SOURCE, "copy");
    (copied.compat as Record<string, unknown>).force_adaptive_thinking = false;
    (copied.input as string[]).push("audio");

    assert.deepStrictEqual(SOURCE.compat, { force_adaptive_thinking: true });
    assert.deepStrictEqual(SOURCE.input, ["text", "image"]);
  });

  it("inherits do_not only when asked", () => {
    assert.deepStrictEqual(buildCopiedModel(SOURCE, "copy", { doNot: ["remove"] }).do_not, ["remove"]);
    assert.strictEqual(buildCopiedModel(SOURCE, "copy", { doNot: [] }).do_not, undefined);
  });

  it("collects models from array and comma-string providers, skipping auto", () => {
    const entries = collectModelEntries([
      { id: "p1", models: [{ id: "m1", name: "Model One" }, { id: "m2" }] },
      { id: "p2", models: "m3, m4" },
      { id: "p3", models: "auto" },
    ]);

    assert.deepStrictEqual(entries.map(e => e.label), [
      "p1 / m1 (Model One)",
      "p1 / m2",
      "p2 / m3",
      "p2 / m4",
    ]);
    assert.strictEqual(entries[2].model.id, "m3");
  });

  it("matches by model id, name or provider id, case-insensitively", () => {
    const entries = collectModelEntries([
      { id: "tokenflux", models: [{ id: "deepseek-v4-flash", name: "V4 Flash" }] },
      { id: "other", models: [{ id: "gpt-5.6" }] },
    ]);

    assert.strictEqual(filterModelEntries(entries, "TOKENFLUX").length, 1);
    assert.strictEqual(filterModelEntries(entries, "v4 flash").length, 1);
    assert.strictEqual(filterModelEntries(entries, "gpt").length, 1);
    assert.strictEqual(filterModelEntries(entries, "nope").length, 0);
    assert.strictEqual(filterModelEntries(entries, "").length, 2);
  });

  it("summarizes copied fields for the confirmation dialog", () => {
    const summary = describeModelFields(buildCopiedModel(SOURCE, "copy"));
    assert.match(summary, /上下文 1\.0M/);
    assert.match(summary, /最大输出 384K/);
    assert.match(summary, /价格 0\.242\/0\.726/);
    assert.match(summary, /模态 text\+image/);
    assert.match(summary, /CoT 回传/);
    assert.match(summary, /compat 1 项/);
    assert.strictEqual(describeModelFields({ id: "x" }), "（无显式字段）");
  });
});
