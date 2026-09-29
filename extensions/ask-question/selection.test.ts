// selection.test.ts — ask_question 选项状态判定（回看高亮 / 历史 / 二次确认）
//
// 跑法：node --test --experimental-strip-types extensions/ask-question/selection.test.ts
//
// 组件里那点状态活在 ui.custom 的闭包里，桩 TUI 不好验；判定抽到这里，
// 用纯函数把「切回来高亮哪一行、换掉自定义输入要不要再问一次」钉住。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HISTORY_LIMIT, lastCustomText, previewOf, pushHistory, restoreOptionIndex, switchDecision } from "./selection.ts";

describe("previewOf：预览只给看开头一段", () => {
	it("够短就原样返回", () => {
		assert.equal(previewOf("用 worktree", 40), "用 worktree");
	});

	it("超宽按列宽截断并带省略号", () => {
		const long = "这是一段很长的自定义输入".repeat(4);
		const out = previewOf(long, 20);
		assert.ok(visibleWidth(out) <= 20, `宽度 ${visibleWidth(out)} 超过 20`);
		assert.match(out, /…$/);
	});

	it("多行压成一行（换行不留到界面上）", () => {
		assert.equal(previewOf("第一行\n第二行\t第三行", 60), "第一行 第二行 第三行");
	});

	it("空文本与退化宽度不给内容", () => {
		assert.equal(previewOf("   ", 40), "");
		assert.equal(previewOf("abc", 1), "");
	});

	it("中文按可见列宽算，不是按字符数", () => {
		assert.equal(visibleWidth(previewOf("中文中文中文", 7)), 7);
	});
});

describe("pushHistory：被换掉的自定义输入不丢", () => {
	it("追加，去重时把旧的挪到最后", () => {
		assert.deepEqual(pushHistory(["a"], "b"), ["a", "b"]);
		assert.deepEqual(pushHistory(["a", "b"], "a"), ["b", "a"]);
	});

	it("上限 3 条，满了丢最旧的", () => {
		assert.equal(HISTORY_LIMIT, 3);
		let list: string[] = [];
		for (const t of ["a", "b", "c", "d"]) list = pushHistory(list, t);
		assert.deepEqual(list, ["b", "c", "d"]);
	});

	it("空白不记", () => {
		assert.deepEqual(pushHistory(["a"], "   "), ["a"]);
	});

	it("不改原数组（闭包里的状态不该被就地改掉）", () => {
		const list = ["a"];
		const next = pushHistory(list, "b");
		assert.deepEqual(list, ["a"]);
		assert.deepEqual(next, ["a", "b"]);
	});
});

describe("lastCustomText：打开编辑器预填什么", () => {
	it("当前答案就是自定义就用它", () => {
		assert.equal(lastCustomText({ value: "手打的", wasCustom: true }, ["旧的"]), "手打的");
	});

	it("当前是普通选项就取最近一条历史", () => {
		assert.equal(lastCustomText({ value: "branch", wasCustom: false }, ["旧一", "旧二"]), "旧二");
	});

	it("都没有就返回 undefined（编辑器留空）", () => {
		assert.equal(lastCustomText(undefined, []), undefined);
		assert.equal(lastCustomText({ value: "branch", wasCustom: false }, []), undefined);
	});
});

describe("restoreOptionIndex：切回来高亮哪一行", () => {
	it("没答过 → 第一项", () => {
		assert.equal(restoreOptionIndex({ optionCount: 3, allowOther: true, historyCount: 0 }), 0);
	});

	it("答的是普通选项 → 回到那一项（答案里记的是 1 基行号）", () => {
		assert.equal(
			restoreOptionIndex({ optionCount: 3, allowOther: true, historyCount: 0, answer: { wasCustom: false, index: 2 } }),
			1,
		);
	});

	it("答的是自定义文本 → 落到「Type something.」那一行", () => {
		assert.equal(
			restoreOptionIndex({ optionCount: 3, allowOther: true, historyCount: 0, answer: { wasCustom: true } }),
			3,
		);
	});

	it("有历史条目时自定义那行仍在选项之后、历史之前", () => {
		assert.equal(
			restoreOptionIndex({ optionCount: 2, allowOther: true, historyCount: 3, answer: { wasCustom: true } }),
			2,
		);
		// 普通选项的行号不受历史影响（历史只往后排）
		assert.equal(
			restoreOptionIndex({ optionCount: 2, allowOther: true, historyCount: 3, answer: { wasCustom: false, index: 2 } }),
			1,
		);
	});

	it("行号越界时夹到合法范围", () => {
		assert.equal(
			restoreOptionIndex({ optionCount: 2, allowOther: false, historyCount: 0, answer: { wasCustom: false, index: 9 } }),
			1,
		);
		assert.equal(
			restoreOptionIndex({ optionCount: 2, allowOther: false, historyCount: 0, answer: { wasCustom: false, index: 0 } }),
			0,
		);
	});

	it("不允许自由输入却有个自定义答案（不该发生）：退回第一项", () => {
		assert.equal(
			restoreOptionIndex({ optionCount: 2, allowOther: false, historyCount: 0, answer: { wasCustom: true } }),
			0,
		);
	});
});

describe("switchDecision：换掉自定义输入要不要再问一次", () => {
	it("之前没答过，或答的是普通选项 → 直接改", () => {
		assert.equal(switchDecision(undefined, undefined, 1), "apply");
		assert.equal(switchDecision({ wasCustom: false }, undefined, 1), "apply");
	});

	it("之前是自定义输入 → 先提示一次", () => {
		assert.equal(switchDecision({ wasCustom: true }, undefined, 1), "confirm");
	});

	it("同一个选项上再按一次 → 确认", () => {
		assert.equal(switchDecision({ wasCustom: true }, { optionIndex: 1 }, 1), "apply");
	});

	it("换到别的选项 → 重新提示（确认状态跟着选项走）", () => {
		assert.equal(switchDecision({ wasCustom: true }, { optionIndex: 1 }, 2), "confirm");
	});
});
