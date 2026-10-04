import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { historyPreview, insertTagAtSelection, insertTextAtSelection, normalizeTagName } from "./text.js";

describe("prompt editor text domain", () => {
  it("normalizes tag names and inserts at a selected range", () => {
    assert.equal(normalizeTagName(" <think> "), "think");
    assert.deepEqual(insertTextAtSelection("hello world", "pi", 6, 11), { text: "hello pi", selectionStart: 8, selectionEnd: 8 });
  });

  it("wraps a selection in a tag and creates an editable body without selection", () => {
    assert.deepEqual(insertTagAtSelection("hello", "think", 1, 4), {
      text: "h<think>ell</think>o", selectionStart: 19, selectionEnd: 19, changed: true,
    });
    assert.deepEqual(insertTagAtSelection("", "response", 0, 0), {
      text: "<response>\n\n</response>", selectionStart: 10, selectionEnd: 12, changed: true,
    });
    assert.equal(insertTagAtSelection("x", "<>", 0, 0).changed, false);
  });

  it("creates a single-line history preview", () => {
    assert.equal(historyPreview("a\nb", 60), "a b");
  });
});
