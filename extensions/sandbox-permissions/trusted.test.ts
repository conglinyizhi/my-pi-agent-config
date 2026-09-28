// trusted.test.ts — 「可信程序目录」的读取与匹配
//
// 跑法：node --test --experimental-strip-types extensions/sandbox-permissions/trusted.test.ts
//
// 这份名单会放宽 AI 命令的审核，所以测试盯的是两件事：
//   1 默认空：没配就谁也不认（保守方向）
//   2 只认目录边界：/opt/tools 不能把 /opt/tools-evil/x 也算进去

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { isTrustedProgramPath, loadTrustedProgramDirs, resetTrustedCache, setTrustedProgramsFile } from "./trusted.ts";

const tempDirs: string[] = [];

function writePaths(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "trusted-test-"));
	tempDirs.push(dir);
	const file = join(dir, "sandbox-paths.json");
	writeFileSync(file, content);
	return file;
}

function usePathsFile(content: string): void {
	setTrustedProgramsFile(writePaths(content));
	resetTrustedCache();
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	resetTrustedCache();
});

describe("可信程序目录", () => {
	it("名单为空 → 谁也不认", () => {
		usePathsFile(JSON.stringify({ allowDirs: [], trustedProgramDirs: [] }));
		assert.deepEqual(loadTrustedProgramDirs(), []);
		assert.equal(isTrustedProgramPath("/home/clyzhi/.pi/runtime/preshell"), false);
	});

	it("字段缺失（老配置文件）→ 当空处理，不抛", () => {
		usePathsFile(JSON.stringify({ allowDirs: ["/tmp"], blockDirs: [] }));
		assert.deepEqual(loadTrustedProgramDirs(), []);
		assert.equal(isTrustedProgramPath("/tmp/x"), false);
	});

	it("坏 JSON / 文件不存在 → 当空处理，不抛", () => {
		usePathsFile("{ 这不是 json");
		assert.deepEqual(loadTrustedProgramDirs(), []);
		setTrustedProgramsFile("/nonexistent/dir/paths.json");
		resetTrustedCache();
		assert.deepEqual(loadTrustedProgramDirs(), []);
	});

	it("列入的目录：目录本身与它下面都算命中", () => {
		usePathsFile(JSON.stringify({ trustedProgramDirs: ["/opt/tools"] }));
		assert.equal(isTrustedProgramPath("/opt/tools"), true, "目录本身");
		assert.equal(isTrustedProgramPath("/opt/tools/sub/bin"), true, "子目录里");
	});

	it("只认目录边界：前缀相似的别家不算", () => {
		usePathsFile(JSON.stringify({ trustedProgramDirs: ["/opt/tools"] }));
		assert.equal(isTrustedProgramPath("/opt/tools-evil/x"), false);
		assert.equal(isTrustedProgramPath("/opt/tool"), false);
	});

	it("~ 写法会展开成家目录", () => {
		usePathsFile(JSON.stringify({ trustedProgramDirs: ["~/.pi/runtime"] }));
		assert.equal(isTrustedProgramPath(join(homedir(), ".pi/runtime/preshell")), true);
		assert.deepEqual(loadTrustedProgramDirs(), [join(homedir(), ".pi/runtime")]);
	});

	it("非字符串条目被丢掉，空串也丢掉", () => {
		usePathsFile(JSON.stringify({ trustedProgramDirs: [42, "", null, "/opt/keep"] }));
		assert.deepEqual(loadTrustedProgramDirs(), ["/opt/keep"]);
	});

	it("尾部斜杠与 .. 会被规范化", () => {
		usePathsFile(JSON.stringify({ trustedProgramDirs: ["/opt/a/b/../tools/"] }));
		assert.deepEqual(loadTrustedProgramDirs(), ["/opt/a/tools"]);
	});

	it("空值不命中（避免空目录字符串把一切都算进去）", () => {
		usePathsFile(JSON.stringify({ trustedProgramDirs: ["/opt/tools"] }));
		assert.equal(isTrustedProgramPath(""), false);
	});
});
