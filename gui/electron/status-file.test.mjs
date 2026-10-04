import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_STATUS_PATH, readStatusSnapshot, resolveStatusPath } from "./status-file.js";

const dir = mkdtempSync(join(tmpdir(), "pi-status-"));
const mine = join(dir, "session-a.json");
writeFileSync(mine, '{"workers":[{"id":"w1"}]}');

describe("resolveStatusPath", () => {
	it("给了存在的路径就用它", () => {
		assert.equal(resolveStatusPath(mine), mine);
	});

	it("给了不存在的路径退回默认", () => {
		assert.equal(resolveStatusPath(join(dir, "没有这个.json")), DEFAULT_STATUS_PATH);
	});

	it("空串与 undefined 都退回默认", () => {
		assert.equal(resolveStatusPath(""), DEFAULT_STATUS_PATH);
		assert.equal(resolveStatusPath(undefined), DEFAULT_STATUS_PATH);
		assert.equal(resolveStatusPath(null), DEFAULT_STATUS_PATH);
	});
});

describe("readStatusSnapshot", () => {
	it("按指定快照读内容，不回退", () => {
		const snap = readStatusSnapshot(mine);
		assert.equal(snap.path, mine);
		assert.equal(JSON.parse(snap.content).workers.length, 1);
		assert.equal(snap.requested, mine);
		assert.equal(snap.fellBack, false);
	});

	it("指定了但读不到：回退默认并标记 fellBack", () => {
		const snap = readStatusSnapshot(join(dir, "没有这个.json"));
		assert.equal(snap.path, DEFAULT_STATUS_PATH);
		assert.equal(snap.fellBack, true);
		assert.equal(snap.requested, join(dir, "没有这个.json"));
	});

	it("没指定：用默认且不算回退", () => {
		const snap = readStatusSnapshot(undefined);
		assert.equal(snap.path, DEFAULT_STATUS_PATH);
		assert.equal(snap.requested, null);
		assert.equal(snap.fellBack, false);
	});
});
