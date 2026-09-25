import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { envNoteHighlights } from "./env-notes.js";
import { mergeEnvHighlights, renderHighlightedCommand } from "./highlights.js";

describe("envNotes → 高亮条目", () => {
  it("解析出来的标绿，文案是 名字 = 值", () => {
    const command = "export OUT=$HOME/out && ls";
    const notes = [{ name: "OUT", raw: "OUT=$HOME/out", start: 7, end: 20, value: "/home/u/out" }];
    const highlights = envNoteHighlights(command, notes);
    assert.deepEqual(highlights, [{ s: 7, e: 20, t: "OUT = /home/u/out", tone: "env" }]);
    assert.equal(command.slice(7, 20), "OUT=$HOME/out");
  });

  it("解析不出来的标灰，文案里带原因", () => {
    const command = "export A=$(pwd)";
    const notes = [{ name: "A", raw: "A=$(pwd)", start: 7, end: 15, reason: "值里含命令替换 $(...)，无法静态解析" }];
    const highlights = envNoteHighlights(command, notes);
    assert.equal(highlights[0].tone, "env-unknown");
    assert.match(highlights[0].t, /A：解析不了/);
    assert.match(highlights[0].t, /命令替换/);
  });

  it("坐标越界或反序的一律丢掉，不画错框", () => {
    const command = "export A=1";
    assert.deepEqual(envNoteHighlights(command, [{ name: "A", start: 7, end: 99, value: "1" }]), []);
    assert.deepEqual(envNoteHighlights(command, [{ name: "A", start: 9, end: 7, value: "1" }]), []);
    assert.deepEqual(envNoteHighlights(command, [{ name: "A", value: "1" }]), []);
    assert.deepEqual(envNoteHighlights(command, null), []);
  });

  it("重叠的赋值只保留前一条", () => {
    const command = "ABCDEFGHIJ";
    const notes = [
      { name: "A", start: 0, end: 6, value: "1" },
      { name: "B", start: 4, end: 8, value: "2" },
      { name: "C", start: 8, end: 10, value: "3" },
    ];
    assert.deepEqual(envNoteHighlights(command, notes).map((h) => h.s), [0, 8]);
  });
});

describe("两类高亮共存", () => {
  it("规则命中优先：与它重叠的赋值高亮丢掉", () => {
    const env = [{ s: 0, e: 8, t: "A = 1", tone: "env" }, { s: 20, e: 26, t: "B = 2", tone: "env" }];
    const rules = [{ s: 5, e: 12, t: "删", n: "rm-recursive" }];
    const merged = mergeEnvHighlights(env, rules);
    assert.deepEqual(merged.map((h) => [h.s, h.e, h.tone ?? "rule"]), [[5, 12, "rule"], [20, 26, "env"]]);
  });

  it("渲染出不同的类名：规则 mark.h，赋值 mark.e / mark.e-u", () => {
    const merged = mergeEnvHighlights(
      [{ s: 0, e: 6, t: "A = 1", tone: "env" }, { s: 7, e: 12, t: "B：解析不了", tone: "env-unknown" }],
      [{ s: 13, e: 16, t: "删", n: "rm-recursive" }],
    );
    const html = renderHighlightedCommand("A=1 && B=2 x rm", merged);
    assert.match(html, /<mark class="e" data-i="0" data-tip="A = 1">A=1 &amp;&amp;<\/mark>/);
    assert.match(html, /<mark class="e e-u" data-i="1"/);
    assert.match(html, /<mark class="h" data-i="2"/);
  });

  it("没有赋值时渲染结果与以前一致（只有规则）", () => {
    const rules = [{ s: 0, e: 4, t: "提权", n: "sudo" }];
    const html = renderHighlightedCommand("sudo ls", mergeEnvHighlights([], rules));
    assert.equal(html, '<mark class="h" data-i="0" data-tip="提权">sudo</mark> ls');
  });
});
