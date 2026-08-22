// paths.test.ts — 目录白/黑名单纯函数与读写测试
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/paths.test.ts

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectCandidateDirs,
	extractPathTokens,
	isDirInside,
	isWhitelisted,
	loadSandboxPaths,
	saveSandboxPaths,
	addAllowDir,
	addBlockDir,
	normalizeDir,
	setPathsFileForTest,
} from "./paths.ts";

const tmp = mkdtempSync(join(tmpdir(), "sandbox-paths-test-"));
setPathsFileForTest(join(tmp, "sandbox-paths.json"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("normalizeDir", () => {
	it("trim 与去尾部斜杠", () => {
		assert.equal(normalizeDir(" /tmp/build/ "), "/tmp/build");
		assert.equal(normalizeDir("/"), "/"); // 根目录保留
	});
	it("展开 ~", () => {
		assert.ok(normalizeDir("~").startsWith("/"));
		assert.ok(normalizeDir("~/work/x").endsWith("/work/x"));
	});
	it("空串 → 空串", () => {
		assert.equal(normalizeDir(""), "");
		assert.equal(normalizeDir("  "), "");
	});
});

describe("extractPathTokens", () => {
	it("提取绝对路径与 ~ 路径", () => {
		const t = extractPathTokens("rm -rf /tmp/build ~/work/out");
		assert.ok(t.includes("/tmp/build"));
		assert.ok(t.some((p) => p.endsWith("/work/out")));
	});
	it("跳过含 shell 元字符的 token", () => {
		assert.deepEqual(extractPathTokens("rm -rf /tmp/$x"), []);
		assert.deepEqual(extractPathTokens("echo /tmp/a/*.log"), []);
	});
	it("跳过相对路径与命令名", () => {
		assert.deepEqual(extractPathTokens("ls -la ./src"), []);
		assert.deepEqual(extractPathTokens("cd src && make"), []);
	});
	it("去重", () => {
		assert.deepEqual(extractPathTokens("rm -rf /tmp/x /tmp/x"), ["/tmp/x"]);
	});
});

describe("isDirInside", () => {
	it("等于或前缀", () => {
		assert.equal(isDirInside("/tmp/build", "/tmp/build"), true);
		assert.equal(isDirInside("/tmp/build/sub/file", "/tmp/build"), true);
		assert.equal(isDirInside("/tmp/build2", "/tmp/build"), false);
		assert.equal(isDirInside("/tmp", "/tmp/build"), false);
	});
	it("根目录包含一切", () => {
		assert.equal(isDirInside("/etc/passwd", "/"), true);
	});
});

describe("isWhitelisted", () => {
	it("全部目标在白名单内 → 放行", () => {
		assert.equal(isWhitelisted("rm -rf /tmp/build", ["/tmp/build"]), true);
		assert.equal(isWhitelisted("rm -rf /tmp/build /tmp/build/cache", ["/tmp/build"]), true);
	});
	it("任一目标在白名单外 → 不放行", () => {
		assert.equal(isWhitelisted("rm -rf /tmp/build /etc", ["/tmp/build"]), false);
	});
	it("allowDirs 为空 / 无路径 → 不放行", () => {
		assert.equal(isWhitelisted("rm -rf /tmp/build", []), false);
		assert.equal(isWhitelisted("echo hi", ["/tmp/build"]), false);
	});
	it("动态构造命令 → 不放行（安全优先）", () => {
		assert.equal(isWhitelisted("rm -rf /tmp/build/$(id)", ["/tmp/build"]), false);
		assert.equal(isWhitelisted("cd /tmp/build && rm -rf $dir", ["/tmp/build"]), false);
	});
});

describe("collectCandidateDirs", () => {
	it("合并 writePaths 与命令路径、去重", () => {
		const c = collectCandidateDirs("rm -rf /tmp/build", ["/tmp/build", "/var/lib"]);
		assert.ok(c.includes("/tmp/build"));
		assert.ok(c.includes("/var/lib"));
		assert.equal(c.filter((p) => p === "/tmp/build").length, 1);
	});
	it("无候选 → 空", () => {
		assert.deepEqual(collectCandidateDirs("echo hi", []), []);
	});
});

describe("sandbox-paths 文件读写", () => {
	it("缺文件 → 空名单", () => {
		assert.deepEqual(loadSandboxPaths(), { allowDirs: [], blockDirs: [] });
	});
	it("save → load 往返", () => {
		saveSandboxPaths({ allowDirs: ["/a"], blockDirs: ["/b", "/b"] });
		assert.deepEqual(loadSandboxPaths(), { allowDirs: ["/a"], blockDirs: ["/b"] });
	});
	it("addAllowDir / addBlockDir 追加去重", () => {
		saveSandboxPaths({ allowDirs: [], blockDirs: [] }); // 清空，避免受前序用例污染
		assert.equal(addAllowDir("/tmp/build"), true);
		assert.equal(addAllowDir("/tmp/build"), false); // 重复
		assert.equal(addAllowDir(" /tmp/build "), false); // 规范化后重复
		assert.equal(addBlockDir("/home/secret"), true);
		const p = loadSandboxPaths();
		assert.deepEqual(p.allowDirs, ["/tmp/build"]);
		assert.deepEqual(p.blockDirs, ["/home/secret"]);
	});
	it("损坏文件 → 空名单（容错）", () => {
		saveSandboxPaths({ allowDirs: [], blockDirs: [] });
		// 覆盖成非法 JSON
		writeFileSync(join(tmp, "sandbox-paths.json"), "not json");
		assert.deepEqual(loadSandboxPaths(), { allowDirs: [], blockDirs: [] });
	});
	it("文件确实被创建", () => {
		addAllowDir("/x");
		assert.ok(existsSync(join(tmp, "sandbox-paths.json")));
	});
});
