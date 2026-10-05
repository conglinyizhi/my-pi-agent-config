import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { versionLabelFrom } from "./slot-version.js";

const fake = (body) => ({ exists: () => true, read: () => body });

describe("槽版本标签", () => {
  it("槽名 + 短 sha", () => {
    const label = versionLabelFrom("/home/u/.pi/runtime/gui/dev/manifest.json", fake(JSON.stringify({ sha: "a86b7d5ffff", dirty: false })));
    assert.equal(label, "dev@a86b7d5");
  });

  it("脏槽标出来", () => {
    const label = versionLabelFrom("/r/gui/stable/manifest.json", fake(JSON.stringify({ sha: "abc1234", dirty: true })));
    assert.equal(label, "stable@abc1234-dirty");
  });

  it("没有 manifest（在仓库里跑）给空串", () => {
    assert.equal(versionLabelFrom("/x/manifest.json", { exists: () => false }), "");
    assert.equal(versionLabelFrom("", fake("{}")), "");
    assert.equal(versionLabelFrom("/r/gui/dev/manifest.json", fake("不是 json")), "");
  });
});
