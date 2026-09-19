// allow.test.ts — sandbox-allow 参数与权限边界测试

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { Value } from "typebox/value";
import {
	applyPathActions,
	SANDBOX_ALLOW_PARAMETERS,
	validateSandboxAllowInput,
	writePathsFullyTrusted,
} from "./allow.ts";
import { addAllowDir, loadSandboxPaths, saveSandboxPaths, setPathsFileForTest } from "./paths.ts";
import {
	addSessionTrustedDirs,
	endSandboxSession,
	getSessionAccessSnapshot,
	resetSandboxSessionForTest,
} from "./session-access.ts";

describe("sandbox-allow 参数契约", () => {
	const base = {
		command: "go install ./cmd/tool",
		permission: "write-paths",
		justification: "需要写入 Go 工具缓存",
		paths: ["~/.go"],
	};

	it("根 schema 是 OpenAI function 要求的 object", () => {
		assert.equal(SANDBOX_ALLOW_PARAMETERS.type, "object");
		assert.equal(Value.Check(SANDBOX_ALLOW_PARAMETERS, base), true);
		assert.equal(Value.Check(SANDBOX_ALLOW_PARAMETERS, {
			command: "echo x",
			permission: "full-access",
			justification: "需要访问无法枚举的系统路径",
		}), true);
	});

	it("运行时区分 write-paths 与 full-access", () => {
		assert.equal(validateSandboxAllowInput(base, "/work/project"), undefined);
		assert.match(validateSandboxAllowInput({ ...base, paths: [] }, "/work/project") ?? "", /需要至少一个/);
		assert.match(validateSandboxAllowInput({ ...base, paths: ["/"] }, "/work/project") ?? "", /非根目录/);
		assert.match(validateSandboxAllowInput({ ...base, paths: ["/."] }, "/work/project") ?? "", /非根目录/);
		assert.match(validateSandboxAllowInput({ ...base, paths: ["/.."] }, "/work/project") ?? "", /非根目录/);
		assert.match(validateSandboxAllowInput({ ...base, paths: ["/tmp", "/"] }, "/work/project") ?? "", /非根目录/);
		assert.equal(validateSandboxAllowInput({
			command: "echo x",
			permission: "full-access",
			justification: "需要访问无法枚举的系统路径",
		}, "/work/project"), undefined);
		assert.match(validateSandboxAllowInput({
			command: "echo x",
			permission: "full-access",
			justification: "需要访问无法枚举的系统路径",
			paths: ["/tmp"],
		}, "/work/project") ?? "", /不接受 paths/);
	});

	it("拒绝空理由和无效 timeout", () => {
		assert.match(validateSandboxAllowInput({ ...base, justification: "" }, "/work/project") ?? "", /justification/);
		assert.match(validateSandboxAllowInput({ ...base, timeout: 0 }, "/work/project") ?? "", /timeout/);
		assert.match(validateSandboxAllowInput({ ...base, timeout: 2_147_484 }, "/work/project") ?? "", /timeout/);
	});
});

describe("sandbox-allow 免审批判定（混合信任）", () => {
	const roots = (allowDirs: string[], sessionTrustedDirs: string[], sessionWriteDirs: string[]) => ({
		allowDirs,
		sessionTrustedDirs,
		sessionWriteDirs,
	});

	it("三档信任混合覆盖请求的全部路径即免审批", () => {
		assert.equal(
			writePathsFullyTrusted(
				["/opt/long/build", "/tmp/trust/cache", "/tmp/write/out"],
				roots(["/opt/long"], ["/tmp/trust"], ["/tmp/write"]),
			),
			true,
		);
	});

	it("任一路径不被任何信任根覆盖则仍需审批", () => {
		assert.equal(
			writePathsFullyTrusted(
				["/opt/long/build", "/tmp/unknown/out"],
				roots(["/opt/long"], ["/tmp/trust"], ["/tmp/write"]),
			),
			false,
		);
	});

	it("空路径列表不免审批（避免 write-paths 漏填时静默放行）", () => {
		assert.equal(writePathsFullyTrusted([], roots(["/opt/long"], ["/tmp/trust"], ["/tmp/write"])), false);
	});

	it("单一档位全覆盖也免审批", () => {
		assert.equal(writePathsFullyTrusted(["/tmp/write/a", "/tmp/write/b"], roots([], [], ["/tmp/write"])), true);
	});
});

describe("sandbox-allow 一次审批应用多条目录动作", () => {
	const tmp = mkdtempSync(join(tmpdir(), "sandbox-allow-actions-"));
	setPathsFileForTest(join(tmp, "sandbox-paths.json"));
	after(() => {
		rmSync(tmp, { recursive: true, force: true });
		endSandboxSession();
	});
	afterEach(() => {
		saveSandboxPaths({ allowDirs: [], blockDirs: [] });
		resetSandboxSessionForTest("session-a");
	});

	it("一次提交可混合长期信任、本 session 信任、黑名单和撤销", () => {
		resetSandboxSessionForTest("session-a");
		addAllowDir("/opt/old");
		addSessionTrustedDirs(["/tmp/old-trust"]);
		const result = applyPathActions(
			[
				{ path: "/opt/new", list: "allow" },
				{ path: "/tmp/session", list: "session-trust" },
				{ path: "/tmp/block", list: "block" },
				{ path: "/opt/old", list: "revoke" },
				{ path: "/tmp/old-trust", list: "revoke" },
			],
			["/opt/new", "/tmp/session", "/tmp/block", "/opt/old", "/tmp/old-trust"],
			"/work/project",
			{ allow: true, rules: [] },
		);
		assert.deepEqual(loadSandboxPaths(), { allowDirs: ["/opt/new"], blockDirs: ["/tmp/block"] });
		assert.deepEqual(getSessionAccessSnapshot("session-a"), {
			writeDirs: ["/tmp/session"],
			trustedDirs: ["/tmp/session"],
		});
		assert.ok(result.writePaths.includes("/opt/new"));
		assert.ok(result.writePaths.includes("/tmp/session"));
	});

	it("命令审计未通过时跳过信任动作，但仍应用黑名单与撤销", () => {
		resetSandboxSessionForTest("session-a");
		addAllowDir("/opt/old");
		applyPathActions(
			[
				{ path: "/opt/new", list: "allow" },
				{ path: "/tmp/session", list: "session-trust" },
				{ path: "/tmp/block", list: "block" },
				{ path: "/opt/old", list: "revoke" },
			],
			["/opt/new", "/tmp/session", "/tmp/block", "/opt/old"],
			"/work/project",
			{ allow: false, rules: [{ name: "rm-recursive" }] },
		);
		assert.deepEqual(loadSandboxPaths(), { allowDirs: [], blockDirs: ["/tmp/block"] });
		assert.deepEqual(getSessionAccessSnapshot("session-a"), { writeDirs: [], trustedDirs: [] });
	});

	it("忽略不在本次 writePaths 里的路径", () => {
		applyPathActions([{ path: "/tmp/sneaky", list: "allow" }], ["/opt/new"], "/work/project", { allow: true, rules: [] });
		assert.deepEqual(loadSandboxPaths(), { allowDirs: [], blockDirs: [] });
	});
});
