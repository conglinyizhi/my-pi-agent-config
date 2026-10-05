import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PROMOTE_THRESHOLD, bumpClean, rollback, setTag, stateOf } from "./ab-tag.ts";

const root = () => mkdtempSync(join(tmpdir(), "ab-tag-"));

describe("一条产品线一个 tag", () => {
	it("切 tag：旧 tag 落到 prev-tag，计数归零", () => {
		const r = root();
		setTag(r, "aaaa111", { dir: "dev" });
		setTag(r, "bbbb222", { dir: "dev", forced: true });
		const state = stateOf(r);
		assert.equal(state.tag, "bbbb222");
		assert.equal(state.prevTag, "aaaa111");
		assert.equal(state.count, 0);
	});

	it("干净往返到阈值才说要切", () => {
		const r = root();
		setTag(r, "aaaa111");
		for (let i = 1; i < PROMOTE_THRESHOLD; i++) assert.equal(bumpClean(r).promote, false);
		assert.equal(bumpClean(r).promote, true);
	});

	it("回退把 tag 与 prev-tag 对调", () => {
		const r = root();
		setTag(r, "aaaa111");
		setTag(r, "bbbb222");
		assert.equal(rollback(r).tag, "aaaa111");
		assert.equal(stateOf(r).prevTag, "bbbb222");
	});

	it("流水是 JSON 行，可追溯", () => {
		const r = root();
		setTag(r, "aaaa111");
		const lines = readFileSync(join(r, "promote.log"), "utf8").trim().split("\n");
		const last = JSON.parse(lines[lines.length - 1]);
		assert.equal(last.event, "update");
		assert.equal(last.to, "aaaa111");
		assert.ok(last.at);
	});
});
