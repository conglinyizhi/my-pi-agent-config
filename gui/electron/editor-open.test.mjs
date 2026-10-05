// 跑法：node --test gui/electron/editor-open.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEditorCommand, detectEditors, EDITOR_REGISTRY } from "./editor-open.js";

const editorOf = (id) => {
  const found = EDITOR_REGISTRY.find((editor) => editor.id === id);
  return { id, label: found.label, bin: found.bins[0], canOpen: true, canDiff: Boolean(found.diff), ...found };
};

describe("探测", () => {
  it("只报本机装了的，并带上能力", () => {
    const available = detectEditors((bin) => bin === "code" || bin === "kompare");
    assert.deepEqual(available.map((editor) => editor.id), ["code", "kompare"]);
    assert.equal(available[0].canDiff, true);
    assert.equal(available[0].canOpen, true);
    assert.equal(available[1].canDiff, true);
    assert.equal(available[1].canOpen, false);
  });

  it("二进制有多个名字时用命中的那个（zed / zeditor）", () => {
    const available = detectEditors((bin) => bin === "zeditor");
    assert.deepEqual(available.map((editor) => [editor.id, editor.bin]), [["zed", "zeditor"]]);
  });

  it("一个都没有时给空数组，不编", () => {
    assert.deepEqual(detectEditors(() => false), []);
  });
});

describe("拼命令", () => {
  it("打开文件并定位到行（VSCode 用 -g）", () => {
    const command = buildEditorCommand(editorOf("code"), { kind: "open", path: "/tmp/a.js", line: 12 });
    assert.deepEqual(command, { bin: "code", args: ["-g", "/tmp/a.js:12"] });
  });

  it("不给行号时只打开文件", () => {
    const command = buildEditorCommand(editorOf("code"), { kind: "open", path: "/tmp/a.js" });
    assert.deepEqual(command, { bin: "code", args: ["/tmp/a.js"] });
  });

  it("Kate 的行定位是 -l 行 文件", () => {
    const command = buildEditorCommand(editorOf("kate"), { kind: "open", path: "/tmp/a.js", line: 3 });
    assert.deepEqual(command, { bin: "kate", args: ["-l", "3", "/tmp/a.js"] });
  });

  it("差异：VSCode 用 --diff，Zed 也是，Kompare 用 -c", () => {
    assert.deepEqual(buildEditorCommand(editorOf("code"), { kind: "diff", left: "/tmp/old", right: "/tmp/new" }), {
      bin: "code",
      args: ["--diff", "/tmp/old", "/tmp/new"],
    });
    assert.deepEqual(buildEditorCommand(editorOf("zed"), { kind: "diff", left: "/tmp/old", right: "/tmp/new" }), {
      bin: "zed",
      args: ["--diff", "/tmp/old", "/tmp/new"],
    });
    assert.deepEqual(buildEditorCommand(editorOf("kompare"), { kind: "diff", left: "/tmp/old", right: "/tmp/new" }), {
      bin: "kompare",
      args: ["-c", "/tmp/old", "/tmp/new"],
    });
  });

  it("编辑器没有差异能力时说清原因，不给一个错的命令", () => {
    const command = buildEditorCommand(editorOf("kate"), { kind: "diff", left: "/tmp/old", right: "/tmp/new" });
    assert.match(command.error, /没有命令行差异模式/);
  });

  it("缺字段时说缺什么", () => {
    assert.match(buildEditorCommand(editorOf("code"), { kind: "open" }).error, /缺少要打开的文件/);
    assert.match(buildEditorCommand(editorOf("code"), { kind: "diff", left: "/tmp/old" }).error, /缺少要比的两份文本/);
    assert.match(buildEditorCommand(null, { kind: "open", path: "/x" }).error, /没有可用的编辑器/);
  });

  it("路径原样进 argv，不经 shell（空格分号都只是文件名）", () => {
    const weird = "/tmp/a b;rm -rf x.js";
    const command = buildEditorCommand(editorOf("code"), { kind: "open", path: weird });
    assert.deepEqual(command.args, [weird]);
  });
});
