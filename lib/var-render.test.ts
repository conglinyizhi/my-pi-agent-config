// lib/var-render.test.ts — 命令里变量引用处的静态渲染（作用域边界 / 三种形态）
//
// 跑法：node --experimental-strip-types lib/var-render.test.ts
//
// 环境一律由用例自带（生产里是 process.env），不依赖本机。
// 每条边界都对着 bash 的实际行为定：作用域判错会把不该放行的命令放过去，所以「拿不准」
// 的写法必须落在 known:false 上，而不是猜一个看起来对的值。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	collectVarRenders,
	MAX_RENDERS,
	referenceAppearsIn,
	staticProgramValues,
	varRendersForApproval,
	type VarRenderSite,
} from "./var-render.ts";

const env: NodeJS.ProcessEnv = {
	HOME: "/home/u",
	USER: "u",
	PATH: "/usr/bin:/bin",
	PWD: "/work",
	JQ: "/usr/bin/jq",
	EMPTY: "",
};

/** 只取断言用得上的字段，输出好读 */
function brief(sites: VarRenderSite[]): Array<Record<string, unknown>> {
	return sites.map((s) => ({
		name: s.name,
		target: s.target,
		kind: s.kind,
		known: s.known,
		...(s.known ? { value: s.value, source: s.source } : { reason: s.reason }),
	}));
}

/** 单个名字的渲染结果（找不到就是 undefined） */
function one(command: string, name = "A", e: NodeJS.ProcessEnv = env): Record<string, unknown> | undefined {
	return brief(collectVarRenders(command, e)).find((item) => item.name === name);
}

describe("var-render：赋值与引用的作用域（bash 实测过的边界）", () => {
	it("独立赋值之后的引用可渲染：&& / ; / 换行 / export 都算", () => {
		for (const command of ["A=1 && echo $A", "A=1; echo $A", "A=1\necho $A", "export A=1 && echo $A", "cd /tmp && A=1 && echo $A"]) {
			const item = one(command);
			assert.equal(item?.known, true, `该渲染：${command}`);
			assert.equal(item?.value, "1", command);
			assert.equal(item?.source, "assignment", command);
		}
	});

	it("`\` + 换行是续行，不把赋值切成前置赋值", () => {
		const command = "A=1 \\\n && echo $A";
		const item = one(command);
		assert.equal(item?.known, true, "续行里 A 仍是独立赋值");
		assert.equal(item?.value, "1");
	});

	it("验收主线：cd /tmp && P=/usr/bin/jq && $P --version", () => {
		const sites = collectVarRenders("cd /tmp && P=/usr/bin/jq && $P --version", env);
		assert.deepEqual(brief(sites), [
			{
				name: "P",
				target: "$P",
				kind: "Exec",
				known: true,
				value: "/usr/bin/jq",
				source: "assignment",
			},
		]);
	});

	it("同一条命令里多处用到同一个变量：结果一致时算确定，不一致时算未知", () => {
		const command = `cd /tmp && P=/usr/bin/jq && $P --version && cat f.json | $P ".a"`;
		const sites = collectVarRenders(command, env);
		// 两处引用都解析出同一个值 → 合成一条（前端按 target 定位，会把两处都标上）
		assert.deepEqual(brief(sites), [
			{ name: "P", target: "$P", kind: "Exec", known: true, value: "/usr/bin/jq", source: "assignment" },
		]);
		assert.deepEqual([...staticProgramValues(command, env)], [
			["$P", { known: true, value: "/usr/bin/jq", source: "assignment" }],
		]);
	});

	it("前置赋值不参与同一个 simple command 的展开（参数先展开、赋值后生效）", () => {
		const item = one("P=/usr/bin/jq $P --version", "P");
		assert.equal(item?.known, false);
		assert.match(String(item?.reason), /前置赋值/);
		assert.equal(one("P=/usr/bin/jq $P --version", "P")?.value, undefined, "known:false 时不许给值");
		// 也不许退回去拿环境变量：bash 里这里拿到的是旧值，环境里的同名值不一定是它
		const withEnv = one("JQ=/bin/other $JQ -n 1", "JQ");
		assert.equal(withEnv?.known, false, "前置赋值一律不渲染，哪怕环境里有同名变量");
	});

	it("引用出现在赋值之前：不可渲染", () => {
		const item = one("echo $A && A=1");
		assert.equal(item?.known, false);
		assert.match(String(item?.reason), /赋值之前/);
	});

	it("环境变量与行内赋值同名时行内赋值优先", () => {
		const item = one("PATH=/my/bin && echo $PATH", "PATH");
		assert.equal(item?.value, "/my/bin");
		assert.equal(item?.source, "assignment");
		// 没有赋值时才用环境变量
		assert.equal(one("echo $PATH", "PATH")?.source, "env");
		assert.equal(one("echo $PATH", "PATH")?.value, "/usr/bin:/bin");
	});

	it("两边都没有：known:false + 一句人话原因", () => {
		const item = one("echo $NOPE", "NOPE");
		assert.equal(item?.known, false);
		assert.match(String(item?.reason), /环境里没有变量 NOPE/);
		assert.match(String(item?.reason), /shell 会话/);
	});

	it("同名多次赋值：不渲染（哪怕其中的位置在 bash 里也说得通）", () => {
		for (const command of ["A=1 && A=2 && echo $A", "A=1 && echo $A && A=2", "A=1\nA=1\n echo $A"]) {
			const item = one(command);
			assert.equal(item?.known, false, `该保守：${command}`);
			assert.match(String(item?.reason), /赋值多次/, command);
		}
	});

	it("同一段里的多个赋值从左到右生效：右边的值可以引用左边的赋值", () => {
		// bash 实测 `A=1 B=$A; echo $B` 得 1
		const item = one("A=1 && B=$A && echo $B", "B");
		assert.equal(item?.known, true);
		assert.equal(item?.value, "1");
	});

	it("export 的参数先整体展开：`export A=1 B=$A` 里 B 拿不到新值", () => {
		// bash 实测 `export A=1 B=$A; echo $B` 是空的
		const item = one("export A=1 B=$A && echo $B", "B");
		assert.equal(item?.known, false);
		assert.match(String(item?.reason), /环境里没有的变量 A/);
		const a = one("export A=1 B=$A && echo $B", "A");
		assert.equal(a?.known, false);
		assert.match(String(a?.reason), /export 的同一段/);
	});
});

describe("var-render：拿不准的一律不渲染", () => {
	it("$1 / $@ / $? 这类特殊参数", () => {
		for (const command of ["echo $1", "echo $@", "echo $?", "echo $#", "echo $*"]) {
			const sites = collectVarRenders(command, env);
			assert.equal(sites.length, 1, command);
			assert.equal(sites[0].known, false, command);
			assert.match(String(sites[0].reason), /特殊参数/, command);
		}
	});

	it("命令替换：值里的算不出来，引用处的值也从那处阻塞", () => {
		const site = one("SRC=$(pwd) && cp $SRC /tmp", "SRC");
		assert.equal(site?.known, false);
		assert.equal(site?.target, "$(pwd)", "阻塞点在赋值里时 target 指那处值文本");
		assert.match(String(site?.reason), /命令替换/);
		// 引用在命令名位置时 kind 仍是 Exec（前端拿它当标签用）
		assert.equal(site?.kind, "Unknown");
		const exec = one("P=$(which jq) && $P --version", "P");
		assert.equal(exec?.kind, "Exec");
		assert.equal(exec?.known, false);
	});

	it("单引号里的字面量不是引用：整条不出现", () => {
		assert.deepEqual(collectVarRenders("echo '$P'", env), []);
		assert.deepEqual(collectVarRenders("echo '$A' && A=1", env), []);
	});

	it("双引号里的引用照旧展开", () => {
		const item = one('echo "pre $PATH post"', "PATH");
		assert.equal(item?.known, true);
		assert.equal(item?.value, "/usr/bin:/bin");
	});

	it("不支持的参数展开：${A:-x} / ${#A} / ${A/u/v} 都不猜", () => {
		for (const command of ["A=1 && echo ${A:-x}", "A=1 && echo ${#A}", "A=1 && echo ${A/u/v}"]) {
			const sites = collectVarRenders(command, env);
			assert.equal(sites.length, 1, command);
			assert.equal(sites[0].known, false, command);
			assert.match(String(sites[0].reason), /不支持的参数展开/, command);
		}
		// 干净的 ${NAME} 是支持的
		assert.equal(one("A=1 && echo ${A}")?.value, "1");
	});

	it("子 shell 里的赋值不外泄（`(A=1)` 与 `$(...)`）", () => {
		assert.equal(one("(A=1) && echo $A")?.known, false);
		assert.equal(one("A=1 && echo $(echo $A)", "A"), undefined, "命令替换里不渲染（另一条命令）");
	});

	it("heredoc 正文与函数体都不参与", () => {
		assert.deepEqual(collectVarRenders("cat > x.sh <<EOF\necho $P\nEOF", env), []);
		assert.equal(one("f() { A=1; } && echo $A")?.known, false, "函数体不执行，里面的赋值不算作用域");
	});

	it("unset 之后不渲染", () => {
		const item = one("A=1 && unset A && echo $A");
		assert.equal(item?.known, false);
		assert.match(String(item?.reason), /unset A/);
	});

	it("自引用 `A=$A` 拿不到新值", () => {
		assert.equal(one("A=$A && echo $A")?.known, false);
	});

	it("PWD / OLDPWD 遇到命令内部的 cd 就判不准", () => {
		assert.match(String(one("cd /tmp && echo $PWD", "PWD")?.reason), /cd/);
		assert.equal(one("echo $PWD", "PWD")?.value, "/work");
	});
});

describe("var-render：输出形状与上限", () => {
	it("payload 形态去掉内部偏移，字段只有契约里那几个", () => {
		const renders = varRendersForApproval("P=/usr/bin/jq && $P -n 1", env);
		assert.deepEqual(renders, [
			{ name: "P", target: "$P", kind: "Exec", known: true, value: "/usr/bin/jq", source: "assignment" },
		]);
		const unknown = varRendersForApproval("SRC=$(pwd) && cp $SRC /tmp", env);
		assert.deepEqual(unknown, [
			{ name: "SRC", target: "$(pwd)", kind: "Unknown", known: false, reason: "值里含命令替换 $(...)，无法静态解析" },
		]);
		// known:false 时不许带 value / source（前端按有没有 value 判能不能悬停显示值）
		for (const entry of unknown) {
			assert.equal("value" in entry, false);
			assert.equal("source" in entry, false);
		}
	});

	it("带引号写给前端的 target 就是命令里的原文片段", () => {
		const site = one('P=/usr/bin/jq && "$P" --version', "P");
		assert.equal(site?.target, "$P");
		const command = 'P=/usr/bin/jq && "$P" --version';
		const start = collectVarRenders(command, env)[0].start;
		assert.equal(command.slice(start, start + 2), "$P");
	});

	it("条数上限与 envNotes 一致（20 条，超出的只丢后面的）", () => {
		const command = Array.from({ length: 30 }, (_, i) => `V${i}=${i}`).join(" ") + " && " + Array.from({ length: 30 }, (_, i) => `$V${i}`).join(" ");
		assert.equal(collectVarRenders(command, env).length, MAX_RENDERS);
		assert.equal(varRendersForApproval(command, env).length, MAX_RENDERS);
	});

	it("命令顺序就是列表顺序", () => {
		const sites = collectVarRenders("A=1 && B=2 && echo $B $A", env);
		assert.deepEqual(sites.map((s) => s.name), ["B", "A"]);
	});

	it("kind：命令名位置是 Exec，参数位置是 Unknown", () => {
		assert.equal(one("A=jq && $A --version")?.kind, "Exec");
		assert.equal(one("A=jq && echo $A")?.kind, "Unknown");
		assert.equal(one("A=jq && echo $(x) | $A")?.kind, "Exec", "管道右侧也是命令名位置");
	});

	it("空命令 / 非字符串输入不炸", () => {
		assert.deepEqual(collectVarRenders("", env), []);
		assert.deepEqual(collectVarRenders(undefined as unknown as string, env), []);
	});
});

describe("staticProgramValues：dynamic-construct 收窄用的查表", () => {
	it("只收命令名位置、且结果一致的引用", () => {
		assert.deepEqual([...staticProgramValues("P=/usr/bin/jq && $P -n 1", env)], [
			["$P", { known: true, value: "/usr/bin/jq", source: "assignment" }],
		]);
		// 参数位置的引用不进这张表（它不是程序名）
		assert.deepEqual([...staticProgramValues("A=jq && echo $A", env)], []);
	});

	it("渲染不出来时给 known:false（调用方据此不收窄）", () => {
		const values = staticProgramValues("P=/usr/bin/jq $P -n 1", env);
		assert.equal(values.get("$P")?.known, false);
	});

	it("同一条引用在多处结果不一致时一律当未知", () => {
		// 这里刻意用同名多次赋值：单条不可能同时是已知与未知，但表必须保守
		const values = staticProgramValues("A=jq && A=less && $A -n 1", env);
		assert.equal(values.get("$A")?.known, false);
	});
});

describe("referenceAppearsIn：给 formatFacts 的标注用", () => {
	it("名字形态做词边界检查，其它片段按原文匹配", () => {
		assert.equal(referenceAppearsIn("$P --version", "$P"), true);
		assert.equal(referenceAppearsIn("$PATH", "$P"), false);
		assert.equal(referenceAppearsIn("echo ${P}", "${P}"), true);
		assert.equal(referenceAppearsIn("cp $(pwd) /tmp", "$(pwd)"), true);
		assert.equal(referenceAppearsIn("cp /tmp /var", "$(pwd)"), false);
		assert.equal(referenceAppearsIn("ls", ""), false);
	});
});
