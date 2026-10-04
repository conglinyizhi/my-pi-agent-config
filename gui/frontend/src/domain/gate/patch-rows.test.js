// 跑法：node --test gui/frontend/src/domain/gate/patch-rows.test.js

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patchCounts, patchToRows } from "./patch-rows.js";

const NL = String.fromCharCode(10);

describe("补丁正文的行", () => {
  it("认出头、hunk、增删与上下文，行号按 hunk 头走", () => {
    const patch = [
      "*** Update File: /tmp/a.txt",
      "@@ -10,3 +10,3 @@",
      " keep",
      "-old line",
      "+new line",
      " tail",
    ].join(NL);
    const rows = patchToRows(patch);
    assert.deepEqual(rows.map((row) => row.kind), ["meta", "meta", "context", "del", "add", "context"]);
    assert.deepEqual(rows[2], { kind: "context", text: "keep", oldLine: 10, newLine: 10 });
    assert.deepEqual(rows[3], { kind: "del", text: "old line", oldLine: 11 });
    assert.deepEqual(rows[4], { kind: "add", text: "new line", newLine: 11 });
    assert.deepEqual(rows[5], { kind: "context", text: "tail", oldLine: 12, newLine: 12 });
  });

  it("统一 diff 的 --- / +++ 头当说明行，不当增删", () => {
    const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-a", "+b"].join(NL);
    const rows = patchToRows(patch);
    assert.deepEqual(rows.slice(0, 2).map((row) => row.kind), ["meta", "meta"]);
    assert.equal(rows[0].text, "--- a/x.ts");
    assert.equal(rows[3].kind, "del");
    assert.equal(rows[4].kind, "add");
  });

  it("看不明格式的行照实摆，不丢", () => {
    const rows = patchToRows(["*** Begin Patch", "*** End Patch"].join(NL));
    assert.deepEqual(rows.map((row) => row.text), ["*** Begin Patch", "*** End Patch"]);
  });

  it("没有 hunk 头时行号缺省，不编一个出来", () => {
    const rows = patchToRows(["-a", "+b"].join(NL));
    assert.equal(rows[0].oldLine, undefined);
    assert.equal(rows[1].newLine, undefined);
  });

  it("空补丁给空数组，尾随换行不产生空行", () => {
    assert.deepEqual(patchToRows(""), []);
    assert.deepEqual(patchToRows(NL), []);
  });

  it("规模按增删行数算", () => {
    const rows = patchToRows(["-a", "-b", "+c"].join(NL));
    assert.deepEqual(patchCounts(rows), { added: 1, removed: 2 });
  });
});
