// allow.test.ts — sandbox-allow 参数与权限边界测试

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { Value } from "typebox/value";
import {
	applyPathActions,
	auditForPathGrants,
	builtinWritableRoots,
	resolveEditedWritePaths,
	SANDBOX_ALLOW_PARAMETERS,
	validateSandboxAllowInput,
	writePathsFullyTrusted,
} from "./allow.ts";
import { parseGuiDecision, toGuiPayload } from "../../lib/approval-channel.ts";
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
				["/opt/long/build", "/var/trust/cache", "/var/write/out"],
				roots(["/opt/long"], ["/var/trust"], ["/var/write"]),
				"/work/project",
			),
			true,
		);
	});

	it("任一路径不被任何信任根覆盖则仍需审批", () => {
		assert.equal(
			writePathsFullyTrusted(
				["/opt/long/build", "/var/unknown/out"],
				roots(["/opt/long"], ["/var/trust"], ["/var/write"]),
				"/work/project",
			),
			false,
		);
	});

	it("空路径列表不免审批（避免 write-paths 漏填时静默放行）", () => {
		assert.equal(writePathsFullyTrusted([], roots(["/opt/long"], ["/var/trust"], ["/var/write"]), "/work/project"), false);
	});

	it("单一档位全覆盖也免审批", () => {
		assert.equal(writePathsFullyTrusted(["/var/write/a", "/var/write/b"], roots([], [], ["/var/write"]), "/work/project"), true);
	});

	it("工作区和 /tmp 这类默认可写根全覆盖时免审批", () => {
		assert.equal(
			writePathsFullyTrusted(
				["/work/project/src", "/tmp/cache", "/dev/null"],
				roots([], [], []),
				"/work/project",
			),
			true,
		);
		assert.ok(builtinWritableRoots("/work/project").includes("/work/project"));
		assert.ok(builtinWritableRoots("/work/project").includes("/tmp"));
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
		addSessionTrustedDirs(["/var/old-trust"]);
		const result = applyPathActions(
			[
				{ path: "/opt/new", list: "allow" },
				{ path: "/var/session", list: "session-trust" },
				{ path: "/var/block", list: "block" },
				{ path: "/opt/old", list: "revoke" },
				{ path: "/var/old-trust", list: "revoke" },
			],
			["/opt/new", "/var/session", "/var/block", "/opt/old", "/var/old-trust"],
			"/work/project",
			{ allow: true, rules: [] },
		);
		assert.deepEqual(loadSandboxPaths(), { allowDirs: ["/opt/new"], blockDirs: ["/var/block"] });
		assert.deepEqual(getSessionAccessSnapshot("session-a"), {
			writeDirs: ["/var/session"],
			trustedDirs: ["/var/session"],
		});
		assert.ok(result.writePaths.includes("/opt/new"));
		assert.ok(result.writePaths.includes("/var/session"));
	});

	it("命令审计未通过时跳过信任动作，但仍应用黑名单与撤销", () => {
		resetSandboxSessionForTest("session-a");
		addAllowDir("/opt/old");
		applyPathActions(
			[
				{ path: "/opt/new", list: "allow" },
				{ path: "/var/session", list: "session-trust" },
				{ path: "/var/block", list: "block" },
				{ path: "/opt/old", list: "revoke" },
			],
			["/opt/new", "/var/session", "/var/block", "/opt/old"],
			"/work/project",
			{ allow: false, rules: [{ name: "rm-recursive", tip: "递归删除", matched: [] }] },
		);
		assert.deepEqual(loadSandboxPaths(), { allowDirs: [], blockDirs: ["/var/block"] });
		assert.deepEqual(getSessionAccessSnapshot("session-a"), { writeDirs: [], trustedDirs: [] });
	});

	it("忽略不在本次 writePaths 里的路径", () => {
		applyPathActions([{ path: "/var/sneaky", list: "allow" }], ["/opt/new"], "/work/project", { allow: true, rules: [] });
		assert.deepEqual(loadSandboxPaths(), { allowDirs: [], blockDirs: [] });
	});

	it("默认可写根上的信任和撤销被忽略，黑名单仍可写入", () => {
		resetSandboxSessionForTest("session-a");
		applyPathActions(
			[
				{ path: "/tmp/cache", list: "allow" },
				{ path: "/work/project/out", list: "revoke" },
				{ path: "/tmp/blocked", list: "block" },
			],
			["/tmp/cache", "/work/project/out", "/tmp/blocked"],
			"/work/project",
			{ allow: true, rules: [] },
		);
		assert.deepEqual(loadSandboxPaths(), { allowDirs: [], blockDirs: ["/tmp/blocked"] });
		assert.deepEqual(getSessionAccessSnapshot("session-a"), { writeDirs: [], trustedDirs: [] });
	});

	it("workspace 可把任意目录设为副工作区，路径不必在候选里", () => {
		const result = applyPathActions(
			[{ path: "/srv/scratch", list: "workspace" }],
			["/opt/new"],
			"/work/project",
			{ allow: true, rules: [] },
		);
		assert.deepEqual(loadSandboxPaths(), { allowDirs: ["/srv/scratch"], blockDirs: [] });
		assert.deepEqual(result.writePaths, ["/opt/new", "/srv/scratch"]);
	});

	it("workspace 拒绝 / 与家目录根，家目录的子目录合法", () => {
		const home = "/home/tester";
		const denied = applyPathActions(
			[
				{ path: "/", list: "workspace" },
				{ path: "/.", list: "workspace" },
				{ path: home, list: "workspace" },
			],
			["/opt/new"],
			"/work/project",
			{ allow: true, rules: [] },
			{ homeDir: home },
		);
		assert.deepEqual(loadSandboxPaths(), { allowDirs: [], blockDirs: [] });
		assert.deepEqual(denied.writePaths, ["/opt/new"]);

		const allowed = applyPathActions(
			[{ path: `${home}/scratch`, list: "workspace" }],
			["/opt/new"],
			"/work/project",
			{ allow: true, rules: [] },
			{ homeDir: home },
		);
		assert.deepEqual(loadSandboxPaths(), { allowDirs: [`${home}/scratch`], blockDirs: [] });
		assert.deepEqual(allowed.writePaths, ["/opt/new", `${home}/scratch`]);
	});

	it("命令审计未通过时 workspace 不授予，也不改写本次范围", () => {
		const result = applyPathActions(
			[{ path: "/srv/scratch", list: "workspace" }],
			["/opt/new"],
			"/work/project",
			{ allow: false, rules: [{ name: "rm-recursive", tip: "危险删除操作", matched: ["rm", "-rf"] }] },
		);
		assert.deepEqual(loadSandboxPaths(), { allowDirs: [], blockDirs: [] });
		assert.deepEqual(result.writePaths, ["/opt/new"]);
	});
});

describe("sandbox-allow 响应里编辑后的执行范围", () => {
	const tmp = mkdtempSync(join(tmpdir(), "sandbox-allow-scope-"));
	setPathsFileForTest(join(tmp, "sandbox-paths.json"));
	after(() => {
		rmSync(tmp, { recursive: true, force: true });
	});
	afterEach(() => {
		saveSandboxPaths({ allowDirs: [], blockDirs: [] });
	});
	const audit = { allow: true, rules: [] };

	it("编辑成父目录：候选被覆盖，本次可写根就是那个父目录", () => {
		const result = applyPathActions([], ["/opt/cache"], "/work/project", audit, {
			editedWritePaths: ["/opt"],
		});
		assert.deepEqual(result.writePaths, ["/opt"]);
	});

	it("编辑成子目录：缩窄到子目录", () => {
		const result = applyPathActions([], ["/opt/cache"], "/work/project", audit, {
			editedWritePaths: ["/opt/cache/sub"],
		});
		assert.deepEqual(result.writePaths, ["/opt/cache/sub"]);
	});

	it("与候选无关的项丢弃，对应原候选保留", () => {
		const result = applyPathActions([], ["/opt/cache"], "/work/project", audit, {
			editedWritePaths: ["/etc"],
		});
		assert.deepEqual(result.writePaths, ["/opt/cache"]);
	});

	it("以闸门窗的完整列表为准：删掉的候选不再自己长回来", () => {
		const result = applyPathActions([], ["/opt/a", "/opt/b"], "/work/project", audit, {
			editedWritePaths: ["/opt/a/sub"],
		});
		assert.deepEqual(result.writePaths, ["/opt/a/sub"]);
	});

	it("无关项被护栅丢后，剩下有效项按列表生效", () => {
		const result = applyPathActions([], ["/opt/a", "/opt/b"], "/work/project", audit, {
			editedWritePaths: ["/opt/a/sub", "/etc"],
		});
		assert.deepEqual(result.writePaths, ["/opt/a/sub"]);
	});

	it("编辑值缺省、非数组或全被丢弃时退回申请值", () => {
		assert.deepEqual(
			applyPathActions([], ["/opt/cache"], "/work/project", audit).writePaths,
			["/opt/cache"],
		);
		assert.deepEqual(
			applyPathActions([], ["/opt/cache"], "/work/project", audit, { editedWritePaths: [] }).writePaths,
			["/opt/cache"],
		);
		assert.deepEqual(
			applyPathActions([], ["/opt/cache"], "/work/project", audit, { editedWritePaths: "not-an-array" }).writePaths,
			["/opt/cache"],
		);
		assert.deepEqual(
			applyPathActions([], [], "/work/project", audit, { editedWritePaths: ["/opt"] }).writePaths,
			[],
		);
	});

	it("编辑值同样过 normalize：相对路径按 cwd 解析，不相关项丢弃", () => {
		assert.deepEqual(resolveEditedWritePaths(["sub"], ["/opt/cache"], "/opt/cache"), ["/opt/cache/sub"]);
		assert.deepEqual(resolveEditedWritePaths([`${homedir()}/cache`], ["/opt/cache"], "/work"), ["/opt/cache"]);
		assert.deepEqual(resolveEditedWritePaths(["/"], ["/opt/cache"], "/work"), ["/opt/cache"]);
		assert.deepEqual(resolveEditedWritePaths(["  ", 7], ["/opt/cache"], "/work"), ["/opt/cache"]);
	});

	it("授权候选仍只认申请值：编辑出来的新路径不能被长期信任", () => {
		applyPathActions([{ path: "/opt/edited", list: "allow" }], ["/opt/cache"], "/work/project", audit, {
			editedWritePaths: ["/opt/edited"],
		});
		assert.deepEqual(loadSandboxPaths(), { allowDirs: [], blockDirs: [] });
	});

	it("GUI 响应经 parseGuiDecision 带出 writePaths，payload 带 homeDir", () => {
		const payload = toGuiPayload({
			kind: "sandbox-allow",
			command: "touch /opt/x",
			permission: "write-paths",
			writePaths: ["/opt/x"],
			justification: "写缓存",
			candidatePaths: ["/opt/x"],
			persistentRoots: [],
			sessionWriteRoots: [],
			sessionTrustedRoots: [],
			builtinRoots: [],
			workspaceRoot: "/work",
		});
		assert.equal(payload.homeDir, homedir());

		const decision = parseGuiDecision({
			action: "allow",
			writePaths: ["  /opt  ", "", 7],
			pathActions: [{ path: "/opt", list: "workspace" }],
		});
		assert.deepEqual(decision.writePaths, ["/opt"]);
		const result = applyPathActions(decision.pathActions, ["/opt/x"], "/work", audit, {
			editedWritePaths: decision.writePaths,
			homeDir: "/home/tester",
		});
			assert.deepEqual(result.writePaths, ["/opt"]);
		assert.deepEqual(loadSandboxPaths(), { allowDirs: ["/opt"], blockDirs: [] });
	});
});

describe("auditForPathGrants（敏感路径不影响目录授权）", () => {
	it("只命中敏感路径：目录授权照旧可用", () => {
		const audit = { allow: false, sensitive: [{ pattern: ".env", token: ".env" }] };
		assert.equal(auditForPathGrants(audit)?.allow, true);
	});

	it("同时命中规则：原样传下去，信任类动作仍被跳过", () => {
		const audit = {
			allow: false,
			sensitive: [{ pattern: ".env", token: ".env" }],
			rules: [{ name: "dynamic-construct", tip: "动态构造", matched: [] }],
		};
		const handed = auditForPathGrants(audit);
		assert.equal(handed?.allow, false);
		assert.equal(handed?.rules?.length, 1);
	});

	it("无审计（yolo / 未审）时保持 undefined", () => {
		assert.equal(auditForPathGrants(undefined), undefined);
	});
});
