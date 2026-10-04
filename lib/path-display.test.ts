// lib/path-display.test.ts
// 跑法：node --test --experimental-strip-types lib/path-display.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayPath, ellipsizeMiddle } from "./path-display.ts";

const home = "/home/clyzhi";
const cwd = "/home/clyzhi/.pi/agent";

describe("displayPath", () => {
	it("家目录下的路径缩成 ~", () => {
		assert.equal(displayPath("/home/clyzhi/notes/a.md", { home }), "~/notes/a.md");
	});

	it("cwd 比家目录深时取更短的 $PWD", () => {
		assert.equal(
			displayPath("/home/clyzhi/.pi/agent/lib/x.ts", { home, cwd }),
			"$PWD/lib/x.ts",
		);
	});

	it("cwd 不在家目录下也照样缩", () => {
		assert.equal(displayPath("/srv/app/src/a.js", { cwd: "/srv/app" }), "$PWD/src/a.js");
	});

	it("恰好是目录本身时只剩记号", () => {
		assert.equal(displayPath("/home/clyzhi", { home }), "~");
		assert.equal(displayPath("/srv/app", { cwd: "/srv/app" }), "$PWD");
	});

	it("目录名带尾斜杠也认得", () => {
		assert.equal(displayPath("/srv/app/a.js", { cwd: "/srv/app/" }), "$PWD/a.js");
	});

	it("两不沾的绝对路径原样返回", () => {
		assert.equal(displayPath("/etc/hosts", { home, cwd }), "/etc/hosts");
	});

	it("相对路径不动", () => {
		assert.equal(displayPath("src/a.js", { home, cwd }), "src/a.js");
	});

	it("空串原样返回", () => {
		assert.equal(displayPath("", { home, cwd }), "");
	});

	it("不给 home/cwd 时不做替换", () => {
		assert.equal(displayPath("/home/clyzhi/a.md"), "/home/clyzhi/a.md");
	});

	it("把根目录当 home/cwd 时不替换（缩了没意义）", () => {
		assert.equal(displayPath("/usr/bin/x", { home: "/", cwd: "/" }), "/usr/bin/x");
	});

	it("前缀像但不同目录的不算（/srv/app2 不属于 /srv/app）", () => {
		assert.equal(displayPath("/srv/app2/a.js", { cwd: "/srv/app" }), "/srv/app2/a.js");
	});

	it("超长路径中间省略，尾巴留得比头多", () => {
		const long = "/srv/deeply/nested/very/long/path/that/keeps/going/and/going/final-file.js";
		const shown = displayPath(long, { cwd: "/srv" });
		assert.equal(shown.length, 64);
		assert.ok(shown.startsWith("$PWD/deep"));
		assert.ok(shown.endsWith("final-file.js"));
		assert.ok(shown.includes("…"));
	});
});

describe("ellipsizeMiddle", () => {
	it("没超长就原样", () => {
		assert.equal(ellipsizeMiddle("/a/b.js", 64), "/a/b.js");
	});
	it("阈值太小时不折腾（宁长勿糊）", () => {
		assert.equal(ellipsizeMiddle("/a/very/long/path.js", 4), "/a/very/long/path.js");
	});
});
