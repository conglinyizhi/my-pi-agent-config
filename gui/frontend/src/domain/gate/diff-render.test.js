// 跑法：node --test gui/frontend/src/domain/gate/diff-render.test.js

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blocksOfRows, escapeHtml, gutterOf, intraHtml, signOf } from "./diff-render.js";

describe("行内差异", () => {
  it("没有区间时就是转义后的原文", () => {
    assert.equal(intraHtml("a < b", []), "a &lt; b");
  });

  it("区间包一层 span，前后内容都保留", () => {
    assert.equal(intraHtml("const a = 1;", [{ s: 10, e: 11 }]), 'const a = <span class="intra">1</span>;');
  });

  it("多个区间按顺序拼，不互相吞", () => {
    assert.equal(intraHtml("abcd", [{ s: 0, e: 1 }, { s: 2, e: 3 }]), '<span class="intra">a</span>b<span class="intra">c</span>d');
  });

  it("越界区间夹回边界，不抛错也不丢内容", () => {
    assert.equal(intraHtml("ab", [{ s: -5, e: 99 }]), '<span class="intra">ab</span>');
    assert.equal(intraHtml("ab", [{ s: 5, e: 9 }]), "ab");
  });

  it("重叠区间让位给前一个，字符不重复出现", () => {
    const html = intraHtml("abcd", [{ s: 0, e: 3 }, { s: 2, e: 4 }]);
    assert.equal(html.replace(/<[^>]+>/g, ""), "abcd");
  });

  it("区间里的尖括号照样转义", () => {
    assert.equal(intraHtml("<a>", [{ s: 0, e: 3 }]), '<span class="intra">&lt;a&gt;</span>');
  });
});

describe("小工具", () => {
  it("符号与行号栏", () => {
    assert.equal(signOf("add"), "+");
    assert.equal(signOf("del"), "-");
    assert.equal(signOf("same"), " ");
    assert.deepEqual(gutterOf({ oldLine: 3 }), { old: "3", next: "" });
    assert.deepEqual(gutterOf({}), { old: "", next: "" });
  });

  it("一维行包成块；空数组仍是空", () => {
    assert.deepEqual(blocksOfRows([{ kind: "add", text: "x" }]), [{ type: "rows", rows: [{ kind: "add", text: "x" }] }]);
    assert.deepEqual(blocksOfRows([]), []);
  });

  it("转义覆盖三种字符", () => {
    assert.equal(escapeHtml("&<>"), "&amp;&lt;&gt;");
  });
});
