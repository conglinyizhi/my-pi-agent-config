// lib/ab-crash.test.ts
// 跑法：node --test --experimental-strip-types lib/ab-crash.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { crashDir, crashRoot, isStampName, listCrashScenes, pruneCrashScenes, saveCrashScene, stampOf } from "./ab-crash.ts";

function setup(): string {
	const root = mkdtempSync(join(tmpdir(), "ab-crash-"));
	mkdirSync(join(root, "gui"), { recursive: true });
	return root;
}

const AT = "2026-10-05T10:11:12.345Z";

describe("存现场", () => {
	it("三样都落下来，权限位是 0600 / 目录 0700", () => {
		const root = setup();
		const result = saveCrashScene({
			runtimeRoot: root,
			component: "gui",
			at: AT,
			reason: "exited",
			exitCode: null,
			signal: "SIGTRAP",
			stderr: "Check failed: 就绪前退出",
			request: { action: "allow" },
		});
		assert.equal(result.saved, true, result.skipped);
		assert.ok(result.dir);
		for (const name of ["scene.json", "stderr.txt", "request.json"]) {
			const file = join(result.dir!, name);
			assert.equal(existsSync(file), true, name);
			assert.equal(statSync(file).mode & 0o777, 0o600, name);
		}
		assert.equal(statSync(result.dir!).mode & 0o777, 0o700);
	});

	it("stderr 为空就不写那个文件（没拿到现场就别装作拿到了）", () => {
		const root = setup();
		const result = saveCrashScene({ runtimeRoot: root, component: "gui", at: AT, reason: "exited" });
		assert.equal(existsSync(join(result.dir!, "stderr.txt")), false);
	});

	it("运行时目录未初始化：跳过，且不造目录", () => {
		const root = mkdtempSync(join(tmpdir(), "ab-crash-"));
		const result = saveCrashScene({ runtimeRoot: join(root, "runtime"), component: "gui", at: AT });
		assert.equal(result.saved, false);
		assert.match(String(result.skipped), /未初始化/);
		assert.equal(existsSync(join(root, "runtime")), false);
	});

	it("路径被占成文件时也不抛", () => {
		const root = setup();
		writeFileSync(crashRoot(root, "gui"), "我不是目录");
		const result = saveCrashScene({ runtimeRoot: root, component: "gui", at: AT });
		assert.equal(result.saved, false);
		assert.ok(result.skipped);
	});
});

describe("清理", () => {
	it("只留最近十份，旧的先走", () => {
		const root = setup();
		for (let index = 0; index < 12; index += 1) {
			const at = `2026-10-05T10:00:${String(index).padStart(2, "0")}.000Z`;
			saveCrashScene({ runtimeRoot: root, component: "gui", at, reason: "exited" });
		}
		const names = listCrashScenes(root, "gui");
		assert.equal(names.length, 10);
		assert.equal(names[0], stampOf("2026-10-05T10:00:02.000Z"), "最早那两份该被清掉");
	});

	it("不认得的东西一律不碰", () => {
		const root = setup();
		for (let index = 0; index < 12; index += 1) {
			const at = `2026-10-05T10:00:${String(index).padStart(2, "0")}.000Z`;
			saveCrashScene({ runtimeRoot: root, component: "gui", at, reason: "exited" });
		}
		writeFileSync(join(crashRoot(root, "gui"), "notes.txt"), "我自己放的笔记");
		mkdirSync(join(crashRoot(root, "gui"), "old-project"), { recursive: true });
		pruneCrashScenes(root, "gui", 3);
		assert.equal(existsSync(join(crashRoot(root, "gui"), "notes.txt")), true, "笔记不该被删");
		assert.equal(existsSync(join(crashRoot(root, "gui"), "old-project")), true, "不认识的项目目录不该被删");
		assert.equal(listCrashScenes(root, "gui").length, 3);
	});

	it("目录名白名单：只认自己那种时间戳", () => {
		assert.equal(isStampName(stampOf(AT)), true);
		assert.equal(isStampName(".."), false);
		assert.equal(isStampName("2026-10-05"), false);
		assert.equal(isStampName("2026-10-05T10-11-12-345Z/.."), false);
		assert.equal(isStampName("crash"), false);
	});

	it("没有现场目录时列表为空，不抛", () => {
		const root = setup();
		assert.deepEqual(listCrashScenes(root, "audit"), []);
		assert.equal(pruneCrashScenes(root, "audit"), 0);
	});
});

describe("路径", () => {
	it("现场放在组件目录下的 crash/", () => {
		assert.equal(crashRoot("/tmp/rt", "gui"), "/tmp/rt/gui/crash");
		assert.equal(crashDir("/tmp/rt", "gui", AT), "/tmp/rt/gui/crash/2026-10-05T10-11-12-345Z");
	});
});
