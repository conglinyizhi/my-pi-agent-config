// allow.test.ts — sandbox-allow 参数与权限边界测试

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import {
	SANDBOX_ALLOW_PARAMETERS,
	validateSandboxAllowInput,
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
