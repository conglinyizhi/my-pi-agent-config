import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PROMOTE_THRESHOLD, bumpClean, noteRoundTrip, rollback, setCandidate, setTag, stateOf } from "./ab-tag.ts";

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

describe("往返记账与看门狗", () => {
	it("干净攒到阈值、有候选就切过去", () => {
		const r = root();
		setTag(r, "live111");
		setCandidate(r, "cand222");
		let last = noteRoundTrip(r, { outcome: "clean", threshold: 2 });
		assert.equal(last.action, "keep");
		last = noteRoundTrip(r, { outcome: "clean", threshold: 2 });
		assert.equal(last.action, "promote");
		assert.equal(stateOf(r).tag, "cand222");
	});

	it("没有候选时攒满也不切，只报干净", () => {
		const r = root();
		setTag(r, "live111");
		const last = noteRoundTrip(r, { outcome: "clean", threshold: 1 });
		assert.equal(last.promoted, false);
		assert.equal(stateOf(r).tag, "live111");
	});

	it("连续失败到阈值回退到 prev-tag", () => {
		const r = root();
		setTag(r, "old111");
		setTag(r, "new222");
		noteRoundTrip(r, { outcome: "failure", failThreshold: 2 });
		const last = noteRoundTrip(r, { outcome: "failure", failThreshold: 2 });
		assert.equal(last.action, "rollback");
		assert.equal(stateOf(r).tag, "old111");
	});

	it("一次干净把失败计数清零", () => {
		const r = root();
		setTag(r, "live111");
		noteRoundTrip(r, { outcome: "failure" });
		noteRoundTrip(r, { outcome: "clean" });
		assert.equal(readFileSync(join(r, "fail"), "utf8").trim(), "0");
	});
});

