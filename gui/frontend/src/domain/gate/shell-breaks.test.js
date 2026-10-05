import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shellBreakPoints } from "./shell-breaks.js";

const cut = (text) => shellBreakPoints(text).map((at) => text.slice(0, at));

describe("shell 软换行点", () => {
	it("分号、管道、&&、|| 之后断开", () => {
		assert.deepEqual(cut("a; b | c && d || e"), ["a;", "a; b |", "a; b | c &&", "a; b | c && d ||"]);
	});

	it("引号里的分隔符不算", () => {
		assert.deepEqual(cut("echo \"a; b\" | wc"), ["echo \"a; b\" |"]);
	});

	it("注释整行跳过", () => {
		assert.deepEqual(cut("ls # a; b\ngrep x | wc"), ["ls # a; b\ngrep x |"]);
	});
});
