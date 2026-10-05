// lib/ab-notice.test.ts
// 跑法：node --test --experimental-strip-types lib/ab-notice.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { noticePath, takeAllNotices, takeNotices } from "./ab-notice.ts";

function setup(): string {
	const root = mkdtempSync(join(tmpdir(), "ab-notice-"));
	mkdirSync(join(root, "gui"), { recursive: true });
	mkdirSync(join(root, "gui"), { recursive: true });
	return root;
}

describe("提示的读取与消费", () => {
	it("读一次之后就空了（消费掉，不重复提示）", () => {
		const root = setup();
		writeFileSync(noticePath(root, "gui"), "2026-10-05 gui 已自动晋升\n\n2026-10-05 协议超前\n", "utf8");
		const first = takeNotices(root, "gui");
		assert.equal(first.length, 2);
		assert.match(first[0], /已自动晋升/);
		assert.deepEqual(takeNotices(root, "gui"), []);
	});

	it("文件不在就给空数组，不造文件", () => {
		const root = setup();
		assert.deepEqual(takeNotices(root, "gui"), []);
		assert.equal(existsSync(noticePath(root, "gui")), false);
	});

	it("两个组件一起读，没提示的不占位置", () => {
		const root = setup();
		writeFileSync(noticePath(root, "gui"), "audit 已攒够 5 次，可以晋升\n", "utf8");
		const all = takeAllNotices(root);
		assert.deepEqual(all.map((entry) => entry.component), ["gui"]);
	});
});
