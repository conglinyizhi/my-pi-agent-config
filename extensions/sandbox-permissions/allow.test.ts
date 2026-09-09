// allow.test.ts — sandbox-allow 参数与权限边界测试

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import {
	SANDBOX_ALLOW_PARAMETERS,
	validateSandboxAllowInput,
	writePathsFullyTrusted,
} from "./allow.ts";

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
