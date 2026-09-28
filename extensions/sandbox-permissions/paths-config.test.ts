// paths-config.test.ts — 三类路径配置的数据层（元数据 / 校验 / 增删分发 / 文案）
//
// 跑法：node --test --experimental-strip-types extensions/sandbox-permissions/paths-config.test.ts
//
// 一律把读写指向 mktemp 目录，绝不碰真实的 sandbox-paths.json。
// 这里盯的不变量：
//   1 三条写入路径（trusted.ts、paths.ts、本模块的分发）互不抹掉对方的键
//   2 三类共用同一套护栏：拒绝 "/" 与家目录本身
//   3 trustedProgramDirs 的确认文案里必须出现「放宽对 AI 命令的审核」

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { addAllowDir, loadSandboxPaths, saveSandboxPaths, setPathsFileForTest } from "./paths.ts";
import { loadTrustedProgramDirs, resetTrustedCache, setTrustedProgramsFile } from "./trusted.ts";
import {
	PATH_LISTS,
	addEntry,
	confirmBody,
	confirmTitle,
	formatPathsList,
	listKeyWords,
	listMeta,
	loadAllLists,
	loadList,
	parseListKey,
	removeEntry,
	tableRows,
	validateEntry,
} from "./paths-config.ts";

const tmp = mkdtempSync(join(tmpdir(), "sandbox-paths-config-test-"));
const jsonFile = join(tmp, "sandbox-paths.json");
setPathsFileForTest(jsonFile);
setTrustedProgramsFile(jsonFile);
after(() => rmSync(tmp, { recursive: true, force: true }));

function writeConfig(doc: Record<string, unknown>): void {
	writeFileSync(jsonFile, JSON.stringify(doc, null, 2) + "\n");
	resetTrustedCache();
}

function readConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(jsonFile, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
	writeConfig({ allowDirs: [], blockDirs: [], trustedProgramDirs: [] });
});

describe("类型词与元数据", () => {
	it("cli / 全名 / 别名都能解析，大小写不敏感", () => {
		assert.equal(parseListKey("trusted"), "trustedProgramDirs");
		assert.equal(parseListKey("TrustedProgramDirs"), "trustedProgramDirs");
		assert.equal(parseListKey("allow"), "allowDirs");
		assert.equal(parseListKey("BLOCK"), "blockDirs");
		assert.equal(parseListKey("黑名单"), undefined);
		assert.equal(parseListKey(""), undefined);
	});

	it("三类都在表里，key 与 JSON 字段名一致", () => {
		assert.deepEqual(
			PATH_LISTS.map((m) => m.key),
			["trustedProgramDirs", "allowDirs", "blockDirs"],
		);
		assert.deepEqual(listKeyWords(), ["trusted", "allow", "block"]);
		assert.equal(listMeta("trustedProgramDirs").humanOnly, true);
		assert.equal(listMeta("allowDirs").humanOnly, undefined);
		assert.equal(listMeta("blockDirs").humanOnly, undefined);
	});
});

describe("validateEntry 护栏（三类共用）", () => {
	it("拒绝根目录 /", () => {
		for (const key of listKeyWords()) {
			const k = parseListKey(key);
			assert.ok(k);
			const r = validateEntry(k, "/");
			assert.equal(r.ok, false, `${key} 应拒绝 /`);
			assert.match(r.ok === false ? r.reason : "", /根目录/);
		}
	});

	it("拒绝家目录本身（含 ~ 展开），子目录合法", () => {
		for (const key of ["trustedProgramDirs", "blockDirs"] as const) {
			assert.equal(validateEntry(key, "~").ok, false);
			assert.equal(validateEntry(key, homedir()).ok, false);
			const ok = validateEntry(key, "~/.pi/runtime");
			assert.equal(ok.ok, true);
			assert.equal(ok.ok === true ? ok.dir : "", join(homedir(), ".pi/runtime"));
		}
	});

	it("空串与纯空白拒绝", () => {
		assert.equal(validateEntry("blockDirs", "   ").ok, false);
		assert.equal(validateEntry("allowDirs", "").ok, false);
	});

	it("规范化：去尾斜杠、消 ..", () => {
		const r = validateEntry("trustedProgramDirs", "  /opt/a/b/../tools/  ");
		assert.equal(r.ok, true);
		assert.equal(r.ok === true ? r.dir : "", "/opt/a/tools");
	});
});

describe("增删分发", () => {
	it("三类各自写进自己的字段，互不覆盖", () => {
		assert.equal(addEntry("trustedProgramDirs", "/opt/tools"), true);
		assert.equal(addEntry("allowDirs", "/tmp/scratch"), true);
		assert.equal(addEntry("blockDirs", "/home/x/secret"), true);

		const doc = readConfig();
		assert.deepEqual(doc.trustedProgramDirs, ["/opt/tools"]);
		assert.deepEqual(doc.allowDirs, ["/tmp/scratch"]);
		assert.deepEqual(doc.blockDirs, ["/home/x/secret"]);

		assert.deepEqual(loadList("trustedProgramDirs"), ["/opt/tools"]);
		assert.deepEqual(loadAllLists(), {
			trustedProgramDirs: ["/opt/tools"],
			allowDirs: ["/tmp/scratch"],
			blockDirs: ["/home/x/secret"],
		});
	});

	it("重复添加返回 false，不重复落盘", () => {
		assert.equal(addEntry("blockDirs", "/tmp/x"), true);
		assert.equal(addEntry("blockDirs", "/tmp/x/"), false);
		assert.deepEqual(readConfig().blockDirs, ["/tmp/x"]);
	});

	it("移除只删对应字段", () => {
		writeConfig({ allowDirs: ["/tmp/a"], blockDirs: ["/tmp/b"], trustedProgramDirs: ["/opt/t"] });
		assert.equal(removeEntry("allowDirs", "/tmp/a"), true);
		const doc = readConfig();
		assert.deepEqual(doc.allowDirs, []);
		assert.deepEqual(doc.blockDirs, ["/tmp/b"]);
		assert.deepEqual(doc.trustedProgramDirs, ["/opt/t"]);
	});

	it("paths.ts 写 allowDirs 时不会把 trustedProgramDirs 抹掉（跨写入路径不变量）", () => {
		writeConfig({ allowDirs: [], blockDirs: [], trustedProgramDirs: ["/opt/tools"] });
		assert.equal(addAllowDir("/tmp/scratch"), true);
		assert.deepEqual(readConfig().trustedProgramDirs, ["/opt/tools"]);
		assert.deepEqual(loadTrustedProgramDirs(), ["/opt/tools"]);

		// 反向：整份 saveSandboxPaths 也不许丢掉它
		saveSandboxPaths({ allowDirs: ["/tmp/other"], blockDirs: [] });
		const doc = readConfig();
		assert.deepEqual(doc.trustedProgramDirs, ["/opt/tools"]);
		assert.deepEqual(loadSandboxPaths().allowDirs, ["/tmp/other"]);
	});
});

describe("文案", () => {
	const file = "/tmp/sandbox-paths.json";

	it("列表带上三类字段名、路径与来源", () => {
		writeConfig({ allowDirs: ["/tmp/a"], blockDirs: [], trustedProgramDirs: [] });
		const text = formatPathsList(loadAllLists(), file);
		for (const key of ["trustedProgramDirs", "allowDirs", "blockDirs"]) assert.match(text, new RegExp(key));
		assert.match(text, /\/tmp\/a/);
		assert.match(text, /（空）/);
		assert.match(text, /来源：/);
		assert.match(text, /人类的权限/);
	});

	it("trusted 的确认文案里必须出现后果：放宽对 AI 命令的审核", () => {
		const body = confirmBody("trustedProgramDirs", "/opt/tools", file);
		assert.match(body, /放宽对 AI 命令的审核/);
		assert.match(body, /人类的权限/);
		assert.match(body, /trustedProgramDirs/);
		assert.match(confirmTitle("trustedProgramDirs", "/opt/tools"), /放宽对 AI 命令的审核/);
	});

	it("allow / block 的确认文案写明各自作用", () => {
		assert.match(confirmBody("allowDirs", "/tmp/a", file), /长期可写根/);
		assert.match(confirmBody("blockDirs", "/tmp/b", file), /敏感/);
		assert.doesNotMatch(confirmBody("allowDirs", "/tmp/a", file), /放宽对 AI 命令的审核/);
	});

	it("tableRows 每条带类型与来源", () => {
		writeConfig({ allowDirs: ["/tmp/a"], blockDirs: ["/tmp/b"], trustedProgramDirs: ["/opt/t"] });
		const rows = tableRows(loadAllLists());
		assert.deepEqual(
			rows.map((r) => r[0]),
			["trusted", "allow", "block"],
		);
		assert.deepEqual(
			rows.map((r) => r[1]),
			["/opt/t", "/tmp/a", "/tmp/b"],
		);
		for (const r of rows) assert.ok(r[2] && r[2].length > 0, `来源列不能空：${r.join("|")}`);
	});
});
