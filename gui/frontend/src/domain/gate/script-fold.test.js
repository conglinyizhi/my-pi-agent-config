// 跑法：node --test gui/frontend/src/domain/gate/script-fold.test.js

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chipIndexOfMark, foldScript, normalizeFoldCalls } from "./script-fold.js";

const call = (over = {}) => ({
  tool: "write",
  kind: "file",
  literal: true,
  startOffset: 0,
  endOffset: 10,
  line: 1,
  endLine: 1,
  ...over,
});

describe("折出片段", () => {
  it("没有调用记录时就是原文一整段", () => {
    const model = foldScript("const a = 1;\n", [], []);
    assert.equal(model.segments.length, 1);
    assert.equal(model.segments[0].text, "const a = 1;\n");
    assert.equal(model.chips.length, 0);
  });

  it("单行调用折成芯片，前后文本留在原地", () => {
    const text = 'const a = tools.write({ path: "/x" });';
    const start = text.indexOf("tools.write");
    const end = text.indexOf(")") + 1;
    const model = foldScript(text, [call({ startOffset: start, endOffset: end, displayPath: "$PWD/x" })], []);
    assert.equal(model.segments.length, 3);
    assert.equal(model.segments[0].text, "const a = ");
    assert.equal(model.segments[1].kind, "chip");
    assert.equal(model.segments[1].chip.label, "tools.write($PWD/x)");
    assert.equal(model.segments[2].text, ";");
  });

  it("多行调用折成一行：内部换行整个消失，分号留在芯片后面", () => {
    const text = ['const a = await tools.write({', '  path: "/x",', '  content: "hi",', "});", "done"].join("\n");
    const start = text.indexOf("tools.write");
    const end = text.indexOf("})") + 2;
    const model = foldScript(text, [call({ startOffset: start, endOffset: end, displayPath: "$PWD/x" })], []);
    const joined = model.segments.map((segment) => (segment.kind === "chip" ? `<${segment.chip.label}>` : segment.text)).join("");
    assert.equal(joined, "const a = await <tools.write($PWD/x)>;\ndone");
  });

  it("bash 芯片是 shell 档，带 cwd 一路写进标签", () => {
    const text = 'tools.bash({ command: "git status", cwd: "/w" });';
    const model = foldScript(text, [call({ tool: "bash", kind: "shell", startOffset: 0, endOffset: 44, displayPath: "$PWD" })], []);
    assert.equal(model.chips[0].tone, "shell");
    assert.equal(model.chips[0].label, "tools.bash($$SHELL$$, cwd=$PWD)");
  });

  it("没有路径的调用标签给省略号，不编一个路径出来", () => {
    const text = "tools.apply_patch({ patch })";
    const model = foldScript(text, [call({ tool: "apply_patch", startOffset: 0, endOffset: text.length })], []);
    assert.equal(model.chips[0].label, "tools.apply_patch(…)");
  });

  it("看不清的调用 literal 为假，UI 可以据此标出来", () => {
    const text = "tools.write({ path: target, content: body })";
    const model = foldScript(text, [call({ literal: false, startOffset: 0, endOffset: text.length })], []);
    assert.equal(model.chips[0].literal, false);
  });
});

describe("记录的体检", () => {
  const text = "0123456789";
  it("丢掉越界与空区间", () => {
    const kept = normalizeFoldCalls(text, [
      call({ startOffset: 0, endOffset: 5 }),
      call({ startOffset: -1, endOffset: 4 }),
      call({ startOffset: 3, endOffset: 99 }),
      call({ startOffset: 6, endOffset: 6 }),
      call({ startOffset: 1.5, endOffset: 4 }),
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].startOffset, 0);
  });

  it("完全包在上一条里的丢掉，部分重叠的留着", () => {
    const kept = normalizeFoldCalls(text, [
      call({ startOffset: 0, endOffset: 8 }),
      call({ startOffset: 2, endOffset: 5 }),
      call({ startOffset: 7, endOffset: 9 }),
    ]);
    assert.deepEqual(kept.map((entry) => [entry.startOffset, entry.endOffset]), [[0, 8], [7, 9]]);
  });

  it("顺序乱的记录会按起点排好", () => {
    const kept = normalizeFoldCalls(text, [
      call({ startOffset: 6, endOffset: 8 }),
      call({ startOffset: 0, endOffset: 3 }),
    ]);
    assert.deepEqual(kept.map((entry) => entry.startOffset), [0, 6]);
  });
});

describe("mark 与折叠的关系", () => {
  const text = 'const a = tools.write({ path: "/x", content: "rm -rf" });';
  const start = text.indexOf("tools.write");
  const end = text.lastIndexOf(")") + 1;
  const calls = [call({ startOffset: start, endOffset: end, displayPath: "$PWD/x" })];

  it("完全落进折掉区间的 mark 归芯片，可视片段里不再出现", () => {
    const inside = { s: text.indexOf("/x"), e: text.indexOf("/x") + 2, t: "路径", n: "r1" };
    const model = foldScript(text, calls, [inside]);
    assert.deepEqual(model.chips[0].hiddenMarks, [0]);
    assert.equal(model.markOwner[0], 0);
    const visible = model.segments.filter((segment) => segment.kind === "text").flatMap((segment) => segment.marks);
    assert.equal(visible.length, 0);
  });

  it("跨边界的 mark 两边都在：芯片挂标记，外侧那截留在片段里", () => {
    const straddling = { s: start - 4, e: start + 3, t: "调用", n: "r2" };
    const model = foldScript(text, calls, [straddling]);
    assert.equal(model.markOwner[0], 0);
    const visible = model.segments.filter((segment) => segment.kind === "text").flatMap((segment) => segment.marks);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].s, straddling.s);
    assert.equal(visible[0].e, start);
  });

  it("片段里的 mark 坐标已经平移到片段内", () => {
    // 芯片吃到最后一个 ) 为止，尾巴只剩分号：这里的 mark 必须按片段坐标给
    const tail = { s: text.length - 1, e: text.length, t: "尾", n: "r3" };
    const model = foldScript(text, calls, [tail]);
    const last = model.segments[model.segments.length - 1];
    assert.equal(last.kind, "text");
    assert.equal(last.text, ";");
    assert.equal(last.marks[0].s, 0);
    assert.equal(last.marks[0].e, last.text.length);
  });

  it("规则类 mark 被折进去时芯片要报警（折叠不能把风险花掉）", () => {
    const danger = { s: text.indexOf("rm -rf"), e: text.indexOf("rm -rf") + 6, t: "危险", n: "r4" };
    const other = { s: text.indexOf("path"), e: text.indexOf("path") + 4, t: "看这里", n: "e1" };
    const model = foldScript(text, calls, [danger, other], { warnMarks: [danger] });
    assert.equal(model.chips[0].warned, true);
    assert.deepEqual(model.chips[0].hiddenMarks, [0, 1]);
  });

  it("chipIndexOfMark 给导航用：没被折住的返回 -1", () => {
    // 芯片前面的高亮：不在任何芯片里
    const before = foldScript(text, calls, [{ s: 0, e: 4, t: "", n: "" }]);
    assert.equal(chipIndexOfMark(before, 0), -1);
    // 芯片里面的高亮：导航跳到它时要弹对应的浮层
    const inside = foldScript(text, calls, [{ s: start, e: start + 2, t: "", n: "" }]);
    assert.equal(chipIndexOfMark(inside, 0), 0);
    // 不存在的序号不炸
    assert.equal(chipIndexOfMark(inside, 99), -1);
  });
});
