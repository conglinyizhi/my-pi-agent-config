// trusted.test.ts — 「可信程序目录」的读取与匹配
//
// 跑法：node --test --experimental-strip-types extensions/sandbox-permissions/trusted.test.ts
//
// 这份名单会放宽 AI 命令的审核，所以测试盯的是两件事：
//   1 默认空：没配就谁也不认（保守方向）
//   2 只认目录边界：/opt/tools 不能把 /opt/tools-evil/x 也算进去

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
	addTrustedProgramDir,
	isTrustedProgramPath,
	loadTrustedProgramDirs,
	removeTrustedProgramDir,
	resetTrustedCache,
	setTrustedProgramsFile,
	trustedCacheStats,
} from "./trusted.ts";

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

describe("缓存：按文件 mtime + size 失效", () => {
	it("同一份文件连续读：第二次命中缓存，不再读盘", () => {
		const file = writePaths(JSON.stringify({ trustedProgramDirs: ["/opt/tools"] }));
		setTrustedProgramsFile(file);
		resetTrustedCache();

		assert.deepEqual(loadTrustedProgramDirs(), ["/opt/tools"]);
		const afterFirst = trustedCacheStats();
		assert.equal(afterFirst.reads, 1, "第一次要读盘");

		assert.deepEqual(loadTrustedProgramDirs(), ["/opt/tools"]);
		const afterSecond = trustedCacheStats();
		assert.equal(afterSecond.reads, 1, "第二次不该再读盘（mtime/size 未变）");
		assert.equal(afterSecond.hits, afterFirst.hits + 1);
	});

	it("文件改了（字节数一模一样）→ 重读，拿到新名单", () => {
		const before = JSON.stringify({ trustedProgramDirs: ["/opt/aaaa"] });
		const after = JSON.stringify({ trustedProgramDirs: ["/opt/bbbb"] });
		assert.equal(Buffer.byteLength(before, "utf8"), Buffer.byteLength(after, "utf8"), "两个样本必须等长");

		const file = writePaths(before);
		setTrustedProgramsFile(file);
		resetTrustedCache();
		assert.deepEqual(loadTrustedProgramDirs(), ["/opt/aaaa"]);

		writeFileSync(file, after);
		// 文件系统时间戳有粒度，同一毫秒内的两次写入 mtime 可能相同 ——
		// 显式把 mtime 往后推，模拟「文件后来被改过」。大小不变，所以这里能过
		// 只可能是 mtime 起了作用（否则会继续吃缓存返回旧值）。
		const bumped = new Date(Date.now() + 2000);
		utimesSync(file, bumped, bumped);

		assert.deepEqual(loadTrustedProgramDirs(), ["/opt/bbbb"], "大小不变但 mtime 变了，必须重读");
		assert.equal(trustedCacheStats().reads, 2);
	});

	it("文件被删掉 → 当空，不用旧缓存", () => {
		const file = writePaths(JSON.stringify({ trustedProgramDirs: ["/opt/tools"] }));
		setTrustedProgramsFile(file);
		resetTrustedCache();
		assert.deepEqual(loadTrustedProgramDirs(), ["/opt/tools"]);

		rmSync(file);
		assert.deepEqual(loadTrustedProgramDirs(), []);
		assert.equal(trustedCacheStats().cached, false, "读不到文件不该留缓存条目");
	});
});

describe("写入：只动 trustedProgramDirs", () => {
	it("新增写的是规范化路径，allowDirs / blockDirs 原样保留", () => {
		const file = writePaths(JSON.stringify({ allowDirs: ["/tmp/a"], blockDirs: ["/home/x/secret"] }));
		setTrustedProgramsFile(file);
		resetTrustedCache();

		assert.equal(addTrustedProgramDir("~/.pi/runtime/"), true);
		const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		assert.deepEqual(doc.trustedProgramDirs, [join(homedir(), ".pi/runtime")]);
		assert.deepEqual(doc.allowDirs, ["/tmp/a"], "别的字段不能被写没");
		assert.deepEqual(doc.blockDirs, ["/home/x/secret"]);
		assert.deepEqual(loadTrustedProgramDirs(), [join(homedir(), ".pi/runtime")], "写完立刻能读到（不吃旧缓存）");
		assert.equal(isTrustedProgramPath(join(homedir(), ".pi/runtime/preshell")), true);
	});

	it("重复 / 根目录 / 空串：不写、返回 false", () => {
		const file = writePaths(JSON.stringify({ trustedProgramDirs: ["/opt/tools"] }));
		setTrustedProgramsFile(file);
		resetTrustedCache();

		assert.equal(addTrustedProgramDir("/opt/tools"), false, "重复");
		assert.equal(addTrustedProgramDir("/"), false, "根目录");
		assert.equal(addTrustedProgramDir("  "), false, "空串");
		const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		assert.deepEqual(doc.trustedProgramDirs, ["/opt/tools"]);
	});

	it("移除只动这一项；不在列表里返回 false 且文件不动", () => {
		const file = writePaths(
			JSON.stringify({ allowDirs: ["/tmp/a"], blockDirs: [], trustedProgramDirs: ["/opt/a", "/opt/b"] }),
		);
		setTrustedProgramsFile(file);
		resetTrustedCache();

		assert.equal(removeTrustedProgramDir("/opt/a/"), true);
		const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		assert.deepEqual(doc.trustedProgramDirs, ["/opt/b"]);
		assert.deepEqual(doc.allowDirs, ["/tmp/a"]);

		const before = readFileSync(file, "utf8");
		assert.equal(removeTrustedProgramDir("/opt/zzz"), false);
		assert.equal(readFileSync(file, "utf8"), before, "移除失败不该改写文件");
	});

	it("坏 JSON 时新增：不猜旧内容，建一份只有 trustedProgramDirs 的", () => {
		const file = writePaths("{ 这不是 json");
		setTrustedProgramsFile(file);
		resetTrustedCache();

		assert.equal(addTrustedProgramDir("/opt/tools"), true);
		const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		assert.deepEqual(doc.trustedProgramDirs, ["/opt/tools"]);
	});
});
