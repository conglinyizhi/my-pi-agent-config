// lib/env-notes.test.ts — 审批窗赋值解析（`export NAME=VALUE` / 前置赋值）
//
// 跑法：node --experimental-strip-types lib/env-notes.test.ts
//
// 解析基准是传进来的 env（生产里就是 pi 进程的环境变量），所以用例全部自带 env，不依赖本机。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectEnvAssignments, expandValue, parseValue, type EnvNote } from "./env-notes.ts";

const env: NodeJS.ProcessEnv = { HOME: "/home/u", USER: "u", EMPTY: "", PATH: "/usr/bin:/bin" };

/** 只取名字与解析结果，方便断言 */
function brief(notes: EnvNote[]): Array<Record<string, string>> {
	return notes.map((n) => ({
		name: n.name,
		raw: n.raw,
		...(n.value !== undefined ? { value: n.value } : {}),
		...(n.reason !== undefined ? { reason: n.reason } : {}),
	}));
}

/** 偏移必须能在原文里原样切出来：前端就是按这个坐标画框的 */
function assertOffsets(command: string, notes: EnvNote[]): void {
	for (const n of notes) {
		assert.equal(command.slice(n.start, n.end), n.raw, `偏移对不上：${n.name}`);
	}
}

describe("env-notes：能解析的赋值", () => {
	it("export 直接赋值", () => {
		const notes = collectEnvAssignments("export FOO=bar", env);
		assert.deepEqual(brief(notes), [{ name: "FOO", raw: "FOO=bar", value: "bar" }]);
		assertOffsets("export FOO=bar", notes);
	});

	it("值里引用环境变量", () => {
		assert.equal(collectEnvAssignments("export FOO=$HOME/x", env)[0]?.value, "/home/u/x");
		assert.equal(collectEnvAssignments("export FOO=${USER}-cfg", env)[0]?.value, "u-cfg");
		assert.equal(collectEnvAssignments('export FOO="$HOME/a b"', env)[0]?.value, "/home/u/a b");
	});

	it("引号语义：单引号不展开，双引号不展开裸 ~", () => {
		assert.equal(collectEnvAssignments("export FOO='$HOME'", env)[0]?.value, "$HOME");
		assert.equal(collectEnvAssignments("export FOO=~/x", env)[0]?.value, "/home/u/x");
		assert.equal(collectEnvAssignments('export FOO="~/x"', env)[0]?.value, "~/x");
	});

	it("默认值形态 ${VAR:-def} / ${VAR-def}", () => {
		assert.equal(collectEnvAssignments("export FOO=${MISSING:-def}", env)[0]?.value, "def");
		assert.equal(collectEnvAssignments("export FOO=${EMPTY:-def}", env)[0]?.value, "def");
		assert.equal(collectEnvAssignments("export FOO=${EMPTY-def}", env)[0]?.value, "");
		assert.equal(collectEnvAssignments("export FOO=${USER:-def}", env)[0]?.value, "u");
	});

	it("转义", () => {
		assert.equal(collectEnvAssignments('export FOO="a\\"b"', env)[0]?.value, 'a"b');
		assert.equal(collectEnvAssignments("export FOO=a\\ b", env)[0]?.value, "a b");
		assert.equal(collectEnvAssignments('export FOO="\\$HOME"', env)[0]?.value, "$HOME");
	});

	it("一次 export 多个赋值", () => {
		const notes = collectEnvAssignments("export A=1 B=$USER C='x y'", env);
		assert.deepEqual(brief(notes), [
			{ name: "A", raw: "A=1", value: "1" },
			{ name: "B", raw: "B=$USER", value: "u" },
			{ name: "C", raw: "C='x y'", value: "x y" },
		]);
		assertOffsets("export A=1 B=$USER C='x y'", notes);
	});
});

describe("env-notes：前置赋值", () => {
	it("段首的赋值", () => {
		const cmd = "FOO=1 BAR=$USER run.sh";
		const notes = collectEnvAssignments(cmd, env);
		assert.deepEqual(brief(notes), [
			{ name: "FOO", raw: "FOO=1", value: "1" },
			{ name: "BAR", raw: "BAR=$USER", value: "u" },
		]);
		assertOffsets(cmd, notes);
	});

	it("分隔符之后、以及 if/then 这类关键字之后也算命令位置", () => {
		const cmd = "cd /tmp && FOO=1 run.sh; if true; then BAR=2 go; fi";
		const notes = collectEnvAssignments(cmd, env);
		assert.deepEqual(notes.map((n) => n.name), ["FOO", "BAR"]);
		assertOffsets(cmd, notes);
	});

	it("参数里的 A=1 不是赋值", () => {
		assert.deepEqual(collectEnvAssignments("echo A=1", env), []);
		assert.deepEqual(collectEnvAssignments("grep -e A=1 file", env), []);
		assert.deepEqual(collectEnvAssignments('git commit -m "export FOO=1"', env), []);
	});

	it("export 后面没有等号就不标（那是导出已有变量）", () => {
		assert.deepEqual(collectEnvAssignments("export FOO", env), []);
		assert.deepEqual(collectEnvAssignments("export -n FOO", env), []);
	});
});

describe("env-notes：解析不了的情况（前端标灰框）", () => {
	it("环境里没有的变量：说明可能是 shell 会话里定义的", () => {
		const notes = collectEnvAssignments("export FOO=$FROM_SHELL", env);
		assert.equal(notes[0]?.value, undefined);
		assert.match(notes[0]?.reason ?? "", /环境里没有的变量 FROM_SHELL/);
		assert.match(notes[0]?.reason ?? "", /shell 会话/);
	});

	it("命令替换与反引号", () => {
		assert.match(collectEnvAssignments("export FOO=$(pwd)", env)[0]?.reason ?? "", /命令替换/);
		assert.match(collectEnvAssignments("export FOO=`date`", env)[0]?.reason ?? "", /反引号/);
	});

	it("特殊参数与不支持的展开形式", () => {
		assert.match(collectEnvAssignments("export FOO=$1", env)[0]?.reason ?? "", /特殊参数/);
		assert.match(collectEnvAssignments("export FOO=${#USER}", env)[0]?.reason ?? "", /不支持的参数展开/);
		assert.match(collectEnvAssignments("export FOO=${USER/u/v}", env)[0]?.reason ?? "", /不支持的参数展开/);
	});

	it("引号没闭合", () => {
		const notes = collectEnvAssignments('export FOO="unclosed', env);
		assert.equal(notes.length, 1);
		assert.match(notes[0]?.reason ?? "", /引号没有闭合/);
		assert.equal(notes[0]?.raw, "FOO=");
	});
});

describe("env-notes：heredoc 正文按「会不会被执行」算", () => {
	it("写文件的正文不算（数据）", () => {
		const cmd = "cat > /tmp/x.sh <<EOF\nexport FOO=1\nEOF";
		assert.deepEqual(collectEnvAssignments(cmd, env), []);
		assert.deepEqual(collectEnvAssignments("cat > /tmp/x.sh <<'EOF'\nexport FOO=1\nEOF", env), []);
	});

	it("shell 吃的正文算（会执行）", () => {
		const cmd = "bash <<EOF\nexport FOO=1\nEOF";
		const notes = collectEnvAssignments(cmd, env);
		assert.deepEqual(notes.map((n) => [n.name, n.value]), [["FOO", "1"]]);
		assertOffsets(cmd, notes);
	});
});

describe("env-notes：边界", () => {
	it("偏移在带引号、带换行的多行命令里也对得上", () => {
		const cmd = 'export A="$HOME"\ncd /tmp && B=2 go\n';
		const notes = collectEnvAssignments(cmd, env);
		assert.deepEqual(notes.map((n) => n.name), ["A", "B"]);
		assertOffsets(cmd, notes);
	});

	it("最多标 20 条", () => {
		const parts = Array.from({ length: 30 }, (_, i) => `V${i}=${i}`);
		assert.equal(collectEnvAssignments(`export ${parts.join(" ")}`, env).length, 20);
	});

	it("空命令与纯空白", () => {
		assert.deepEqual(collectEnvAssignments("", env), []);
		assert.deepEqual(collectEnvAssignments("   \n  ", env), []);
	});

	it("expandValue / parseValue 是纯函数，可直接调", () => {
		assert.deepEqual(expandValue("$HOME", "double", env), { ok: true, value: "/home/u" });
		assert.deepEqual(parseValue("'a b' rest", 0), { end: 5, body: "a b", quote: "single" });
	});
});
