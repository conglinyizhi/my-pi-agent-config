// helpers.test.ts — sandbox-allow 纯函数测试
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/helpers.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildApprovalTitle,
	buildEscalationEnv,
	expandTilde,
	resolveWritePaths,
} from "./helpers.ts";

describe("expandTilde", () => {
	it("展开 ~ 与 ~/", () => {
		assert.equal(expandTilde("~"), homedir());
		assert.equal(expandTilde("~/a/b"), join(homedir(), "a", "b"));
	});
	it("非 ~ 前缀原样返回", () => {
		assert.equal(expandTilde("/usr/bin/bash"), "/usr/bin/bash");
		assert.equal(expandTilde("foo"), "foo");
	});
});

describe("resolveWritePaths", () => {
	const cwd = "/work/proj";
	it("相对路径基于 cwd 解析为绝对路径", () => {
		assert.deepEqual(resolveWritePaths(["out", "/var/lib"], cwd), ["/work/proj/out", "/var/lib"]);
	});
	it("去空、去重", () => {
		assert.deepEqual(resolveWritePaths([" /tmp", "", "/tmp", "  "], cwd), ["/tmp"]);
	});
	it("undefined / 空数组 → 空数组", () => {
		assert.deepEqual(resolveWritePaths(undefined, cwd), []);
		assert.deepEqual(resolveWritePaths([], cwd), []);
	});
});

describe("buildEscalationEnv", () => {
	it("full-access 设 DISABLE 并清除既有沙箱约束", () => {
		const base = { PI_SANDBOX_RW: "/work/sandbox", PI_SANDBOX_READONLY: "1", PI_SANDBOX_RW_EXTRA: "/x", FOO: "bar" };
		const env = buildEscalationEnv(base, "full-access", []);
		assert.equal(env.PI_SANDBOX_DISABLE, "1");
		assert.equal(env.PI_SANDBOX_RW, undefined);
		assert.equal(env.PI_SANDBOX_READONLY, undefined);
		assert.equal(env.PI_SANDBOX_RW_EXTRA, undefined);
		assert.equal(env.FOO, "bar"); // 不丢无关变量
	});
	it("write-paths 叠加 RW_EXTRA、保留既有 PI_SANDBOX_RW（子 agent 场景）", () => {
		const base = { PI_SANDBOX_RW: "/work/sandbox", PI_SANDBOX_READONLY: "1" };
		const env = buildEscalationEnv(base, "write-paths", ["/extra/a", "/extra/b"]);
		assert.equal(env.PI_SANDBOX_RW_EXTRA, "/extra/a:/extra/b");
		assert.equal(env.PI_SANDBOX_RW, "/work/sandbox");
		assert.equal(env.PI_SANDBOX_READONLY, "1");
	});
	it("write-paths 无路径时不设 RW_EXTRA", () => {
		const env = buildEscalationEnv({}, "write-paths", []);
		assert.equal(env.PI_SANDBOX_RW_EXTRA, undefined);
	});
});

describe("buildApprovalTitle", () => {
	it("包含命令、权限与理由", () => {
		const t = buildApprovalTitle("echo hi", "full-access", [], "因为要写系统目录");
		assert.ok(t.includes("echo hi"));
		assert.ok(t.includes("完全开放"));
		assert.ok(t.includes("因为要写系统目录"));
		assert.ok(t.includes("仅此一次"));
	});
	it("write-paths 列出可写目录", () => {
		const t = buildApprovalTitle("make install", "write-paths", ["/opt/x", "/usr/local"], "安装到系统目录");
		assert.ok(t.includes("/opt/x、/usr/local"));
		assert.ok(t.includes("保持只读沙箱"));
	});
	it("超长命令截断", () => {
		const t = buildApprovalTitle("x".repeat(500), "full-access", [], undefined);
		assert.ok(t.length < 400);
		assert.ok(t.includes("（未提供）"));
	});
});
