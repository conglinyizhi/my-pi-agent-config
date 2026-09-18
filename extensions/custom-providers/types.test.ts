import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatInputCapabilities,
  isDefaultInput,
  parseInputCapabilities,
  toPiInput,
  toggleInputCapability,
} from "./types.ts";

describe("parseInputCapabilities", () => {
  it("keeps the four known modalities in a stable order and drops unknowns", () => {
    assert.deepStrictEqual(
      parseInputCapabilities(["audio", "text", "video", "image", "text", "unknown"]),
      ["text", "image", "video", "audio"],
    );
  });

  it("treats missing, empty, and all-unknown as unset", () => {
    assert.strictEqual(parseInputCapabilities(undefined), undefined);
    assert.strictEqual(parseInputCapabilities("text"), undefined);
    assert.strictEqual(parseInputCapabilities([]), undefined);
    assert.strictEqual(parseInputCapabilities(["unknown"]), undefined);
  });
});

describe("toggleInputCapability", () => {
  it("toggles one capability without disturbing the rest", () => {
    assert.deepStrictEqual(toggleInputCapability(["text"], "image"), ["text", "image"]);
    assert.deepStrictEqual(toggleInputCapability(["text", "image"], "image"), ["text"]);
    assert.deepStrictEqual(toggleInputCapability(["text", "audio"], "video"), ["text", "video", "audio"]);
    assert.deepStrictEqual(toggleInputCapability([], "audio"), ["audio"]);
  });
});

describe("toPiInput", () => {
  it("keeps only text/image for the pi SDK and falls back to text", () => {
    assert.deepStrictEqual(toPiInput(["text", "image", "video", "audio"]), ["text", "image"]);
    assert.deepStrictEqual(toPiInput(["image"]), ["image"]);
    assert.deepStrictEqual(toPiInput(["video", "audio"]), ["text"]);
    assert.deepStrictEqual(toPiInput(undefined), ["text"]);
  });
});

describe("format / default helpers", () => {
  it("prints chinese labels and treats text-only as the default", () => {
    assert.strictEqual(formatInputCapabilities(["text", "video", "audio"]), "文本 + 视频 + 声音");
    assert.strictEqual(isDefaultInput(undefined), true);
    assert.strictEqual(isDefaultInput(["text"]), true);
    assert.strictEqual(isDefaultInput(["text", "image"]), false);
    assert.strictEqual(isDefaultInput(["audio"]), false);
  });
});
