// 跑法：node --test gui/frontend/src/domain/gate/editor-items.test.js

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editorItems, emptyMenuHint } from "./editor-items.js";

const code = { id: "code", label: "VSCode", canOpen: true, canDiff: true };
const kate = { id: "kate", label: "Kate", canOpen: true, canDiff: false };
const kompare = { id: "kompare", label: "Kompare", canOpen: false, canDiff: true };

describe("菜单条目", () => {
  it("有路径时每台能打开的编辑器给一条", () => {
    const items = editorItems([code, kate, kompare], { path: "/tmp/a.js" });
    assert.deepEqual(items.map((item) => item.text), ["在 VSCode 打开", "在 Kate 打开"]);
  });

  it("带行号时写在条目里，也带进目标", () => {
    const items = editorItems([code], { path: "/tmp/a.js", line: 12 });
    assert.equal(items[0].text, "在 VSCode 打开（第 12 行）");
    assert.deepEqual(items[0].target, { kind: "open", path: "/tmp/a.js", line: 12 });
  });

  it("只有新旧文时给差异条目，缺一边就不给", () => {
    assert.deepEqual(editorItems([code, kompare], { left: "a", right: "b" }).map((item) => item.text), [
      "在 VSCode 查看差异",
      "在 Kompare 查看差异",
    ]);
    assert.deepEqual(editorItems([code], { left: "a" }), []);
  });

  it("补丁走打开补丁那条，目标是补丁正文", () => {
    const items = editorItems([code], { patchText: "@@" });
    assert.deepEqual(items.map((item) => item.text), ["在 VSCode 打开补丁"]);
    assert.deepEqual(items[0].target, { kind: "patch", patchText: "@@" });
  });

  it("没有编辑器、或请求里什么都没有时给空菜单", () => {
    assert.deepEqual(editorItems([], { path: "/tmp/a.js" }), []);
    assert.deepEqual(editorItems([code, kate], {}), []);
    assert.deepEqual(editorItems(null, { path: "/x" }), []);
  });

  it("缺字段的编辑器条目不出现（能力标记说了算）", () => {
    const broken = { id: "x", label: "X" };
    assert.deepEqual(editorItems([broken], { path: "/x", left: "a", right: "b" }), []);
  });
});

describe("空菜单的提示", () => {
	it("没有可打开的目标时说目标，不甩锅给编辑器", () => {
		const hint = emptyMenuHint({}, [{ id: "code", label: "VSCode", canOpen: true, canDiff: true }]);
		assert.match(hint, /没有可打开的目标/);
	});

	it("目标在但一台编辑器都没有，才说编辑器", () => {
		assert.match(emptyMenuHint({ path: "/tmp/a.js" }, []), /没找到支持的编辑器/);
	});

	it("编辑器和目标都在，却一条都拼不出来，说明是能力不够", () => {
		const hint = emptyMenuHint({ left: "a", right: "b" }, [{ id: "kate", label: "Kate", canOpen: true, canDiff: false }]);
		assert.match(hint, /干不了这件事/);
	});

	it("补丁也算目标", () => {
		assert.match(emptyMenuHint({ patchText: "@@" }, []), /没找到支持的编辑器/);
	});
});

