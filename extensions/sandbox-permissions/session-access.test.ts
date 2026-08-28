// session-access.test.ts — 当前 session 可写根/信任根生命周期测试

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it, afterEach } from "node:test";
import {
	addSessionTrustedDirs,
	addSessionWriteDirs,
	addSessionWriteDirsToEnv,
	beginSandboxSession,
	endSandboxSession,
	getSessionAccessSnapshot,
	normalizeSandboxRoot,
	pathsCoveredByRoots,
	resetSandboxSessionForTest,
} from "./session-access.ts";

afterEach(() => endSandboxSession());

describe("session sandbox access", () => {
	it("session write root 只提供当前 session 的 shell 写权限", () => {
		resetSandboxSessionForTest("session-a");
		assert.deepEqual(addSessionWriteDirs(["~/.go", "./out", "./out/../cache"], "/work/project"), [
			`${homedir()}/.go`,
			"/work/project/out",
			"/work/project/cache",
		]);
		assert.deepEqual(getSessionAccessSnapshot("session-a"), {
			writeDirs: [`${homedir()}/.go`, "/work/project/cache", "/work/project/out"],
			trustedDirs: [],
		});
		assert.deepEqual(addSessionWriteDirsToEnv({ FOO: "bar" }, "session-a"), {
			FOO: "bar",
			PI_SANDBOX_RW_EXTRA: `${homedir()}/.go:/work/project/cache:/work/project/out`,
		});
	});

	it("session trust root 同时加入 write roots，但只覆盖其自身及子路径", () => {
		resetSandboxSessionForTest("session-a");
		assert.deepEqual(addSessionTrustedDirs(["/tmp/moon"], "/work/project"), ["/tmp/moon"]);
		const access = getSessionAccessSnapshot("session-a");
		assert.deepEqual(access.trustedDirs, ["/tmp/moon"]);
		assert.deepEqual(access.writeDirs, ["/tmp/moon"]);
		assert.equal(pathsCoveredByRoots(["/tmp/moon/build"], access.trustedDirs), true);
		assert.equal(pathsCoveredByRoots(["/tmp/moon2"], access.trustedDirs), false);
	});

	it("session ID 变化或结束时清空临时授权", () => {
		resetSandboxSessionForTest("session-a");
		addSessionTrustedDirs(["/tmp/moon"]);
		beginSandboxSession("session-b");
		assert.deepEqual(getSessionAccessSnapshot("session-b"), { writeDirs: [], trustedDirs: [] });
		addSessionWriteDirs(["/tmp/build"]);
		endSandboxSession();
		assert.deepEqual(getSessionAccessSnapshot("session-c"), { writeDirs: [], trustedDirs: [] });
	});

	it("拒绝根目录，规范化相对路径与 ..", () => {
		assert.equal(normalizeSandboxRoot("/"), undefined);
		assert.equal(normalizeSandboxRoot(".", "/work/project"), "/work/project");
		assert.equal(normalizeSandboxRoot("../outside", "/work/project"), "/work/outside");
	});
});
