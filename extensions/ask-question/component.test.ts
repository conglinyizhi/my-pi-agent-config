// component.test.ts — ask_question 的 TUI 组件：回看高亮 / 自定义输入的历史 / 换选项二次确认
//
// 跑法：node --test --experimental-strip-types extensions/ask-question/component.test.ts
//
// 这次真的把组件建起来：假 ctx.ui.custom 拿到工厂返回的组件对象，然后按真实按键序列驱动
// handleInput，断言 render() 出来的行。判定那半边在 selection.test.ts（纯函数），
// 这里验的是「线接对了没有」：切标签页会不会回到原答案、提示出不出得来、历史有没有列上。
//
// 两条环境纪律（照 smoke.test.ts 的规矩）：
//   - PI_HUB_SOCKET 指到一个不存在的 socket：不然真 hub 会把问题扇出去
//   - PI_NOTIFY_TEST=1：否则每跑一次弹一条真实桌面通知

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "ask-question-component-"));
const savedSocket = process.env.PI_HUB_SOCKET;
const savedNotify = process.env.PI_NOTIFY_TEST;
process.env.PI_HUB_SOCKET = join(dir, "no-hub.sock");
process.env.PI_NOTIFY_TEST = "1";

after(() => {
	rmSync(dir, { recursive: true, force: true });
	if (savedSocket === undefined) delete process.env.PI_HUB_SOCKET;
	else process.env.PI_HUB_SOCKET = savedSocket;
	if (savedNotify === undefined) delete process.env.PI_NOTIFY_TEST;
	else process.env.PI_NOTIFY_TEST = savedNotify;
});

type ToolDef = { execute: (...args: unknown[]) => Promise<unknown> };
const tools = new Map<string, ToolDef>();
const { default: register } = await import("./index.ts");
register({ registerTool: (def: ToolDef & { name: string }) => tools.set((def as { name: string }).name, def) } as never);
const askQuestion = tools.get("ask_question");
assert.ok(askQuestion, "没注册上 ask_question");

/** 主题桩：只把颜色函数打平成纯文本，断言的就是「哪一行有什么字」 */
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

/** Editor 渲染时要问终端高度（算可见行数），所以 terminal.rows 也得给 */
const fakeTui = {
	requestRender: () => {},
	getWidth: () => 100,
	getHeight: () => 40,
	setStatus: () => {},
	terminal: { rows: 40, columns: 100 },
} as never;

const KEYS = {
	up: "\u001b[A",
	down: "\u001b[B",
	enter: "\r",
	tab: "\t",
	shiftTab: "\u001b[Z",
	esc: "\u001b",
};

const TWO_QUESTIONS = [
	{
		id: "q1",
		label: "隔离方式",
		question_text: "这次改造会动共享脚本，怎么隔离工作区？",
		options: [
			{ value: "worktree", label: "用 git worktree 隔离" },
			{ value: "branch", label: "直接开分支" },
		],
		allowOther: true,
	},
	{
		id: "q2",
		label: "提交粒度",
		question_text: "提交怎么分？",
		options: [
			{ value: "one", label: "一个提交" },
			{ value: "many", label: "按文件拆" },
		],
		allowOther: true,
	},
];

interface Component {
	render: (width: number) => string[];
	handleInput: (data: string) => void;
}

/** 起一次提问，拿到组件与结果 promise */
function start(questions = TWO_QUESTIONS) {
	let component: Component | undefined;
	const notices: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "sess-component" },
		ui: {
			notify: (message: string) => notices.push(message),
			custom: (factory: (...args: unknown[]) => Component) =>
				new Promise((resolve) => {
					component = factory(fakeTui, plainTheme, {}, resolve);
				}),
		},
	};
	const result = askQuestion!.execute("call-1", { questions }, undefined, undefined, ctx) as Promise<{
		details: { answers: { id: string; value: string; wasCustom: boolean }[]; cancelled: boolean };
	}>;
	return { component: () => component, result, notices };
}

/** 等组件被工厂建出来（ui.custom 是在 execute 的第一拍里同步调的） */
async function settle(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
}

function lines(component: Component, width = 100): string[] {
	return component.render(width).map((l) => l.trimEnd());
}

/** 当前高亮的那一行（选项前缀是 "> "） */
function highlighted(component: Component, width = 100): string {
	const hit = lines(component, width).find((l) => l.startsWith("> "));
	return (hit ?? "").trim();
}

/**
 * 切回第一题。答完最后一题会落在「提交」页（那一页没有选项行），
 * 硬编码按键次数容易写错，这里按渲染出来的题干判断到底了没有。
 */
function backToQuestionOne(component: Component): void {
	for (let i = 0; i < 5; i++) {
		if (lines(component).some((l) => l.includes("这次改造会动共享脚本"))) return;
		component.handleInput(KEYS.shiftTab);
	}
	assert.fail(`回不到第一题：\n${lines(component).join("\n")}`);
}

async function drive(component: () => Component | undefined, keys: string[]): Promise<Component> {
	await settle();
	const c = component();
	assert.ok(c, "组件没建起来");
	for (const key of keys) c!.handleInput(key);
	return c!;
}

describe("切回已答的问题", () => {
	it("普通选项：回来时高亮原来那一项，不是永远第一项", async () => {
		const h = start();
		const c = await drive(h.component, [KEYS.down, KEYS.enter, KEYS.enter]); // q1 选第 2 项 → q2 选第 1 项
		c.handleInput(KEYS.shiftTab); // 提交页 → q2
		assert.match(highlighted(c), /1\. 一个提交/, "答过的 q2 也该回到原答案");

		backToQuestionOne(c);
		assert.match(highlighted(c), /2\. 直接开分支/, "切回来该高亮原来选的第 2 项");
	});

	it("自定义文本：高亮「Type something.」并在下面展示填过的内容", async () => {
		const h = start();
		const c = await drive(h.component, [KEYS.down, KEYS.down, KEYS.enter, "手打的一版方案", KEYS.enter, KEYS.enter]);
		// ↑ q1 选到 Type something.（第 3 行）→ 输入 → 提交；q2 选第 1 项
		backToQuestionOne(c);
		const rendered = lines(c).join("\n");
		assert.match(highlighted(c), /3\. Type something\./, "自定义答案回来该停在 Type something.");
		assert.match(rendered, /已填：手打的一版方案/, "要展示填过内容的前一段");
	});

	it("超长的自定义文本在渲染里被截断（终端宽度有限）", async () => {
		const h = start();
		const long = "这一段自定义输入特别长".repeat(12);
		const c = await drive(h.component, [KEYS.down, KEYS.down, KEYS.enter, long, KEYS.enter, KEYS.enter]);
		backToQuestionOne(c);
		const previewLines = lines(c, 60).filter((l) => l.includes("已填："));
		assert.equal(previewLines.length, 1, "预览就该一行（切掉，不折行）");
		const preview = previewLines[0] as string;
		assert.ok(preview.endsWith("…"), `超宽要截断：${preview}`);
		assert.ok(preview.length < long.length, "不该把整段都渲染出来");
	});
});

describe("换掉自定义输入", () => {
	it("先给黄字提示，同一个选项再按一次才真改，旧文本进历史", async () => {
		const h = start();
		const c = await drive(h.component, [KEYS.down, KEYS.down, KEYS.enter, "手打的一版方案", KEYS.enter, KEYS.enter]);
		backToQuestionOne(c);

		c.handleInput(KEYS.up); // 挪到第 2 项
		c.handleInput(KEYS.up); // 第 1 项
		c.handleInput(KEYS.enter); // 第一次：只出提示，不改
		assert.match(lines(c).join("\n"), /⚠ 已有自定义输入，再按一次 Enter 确认改成「用 git worktree 隔离」/);
		assert.match(highlighted(c), /1\. 用 git worktree 隔离/);

		c.handleInput(KEYS.enter); // 第二次：确认（确认后会跳到下一题）
		backToQuestionOne(c);
		const rendered = lines(c).join("\n");
		assert.match(rendered, /↺ 之前输入 1/, "被换掉的自定义文本要进历史列表");
		assert.match(rendered, /手打的一版方案/, "历史条目下面给预览");
	});

	it("提示出来后挪开一步或按 Esc 就放弃这次修改", async () => {
		const h = start();
		const c = await drive(h.component, [KEYS.down, KEYS.down, KEYS.enter, "手打的一版方案", KEYS.enter, KEYS.enter]);
		backToQuestionOne(c);

		c.handleInput(KEYS.up);
		c.handleInput(KEYS.enter); // 出提示
		assert.match(lines(c).join("\n"), /⚠ 已有自定义输入/);

		c.handleInput(KEYS.esc); // 放弃修改（不是取消整个提问）
		c.handleInput(KEYS.down); // 回到 Type something.
		const rendered = lines(c).join("\n");
		assert.doesNotMatch(rendered, /⚠ 已有自定义输入/, "提示该收掉了");
		assert.match(highlighted(c), /Type something\./);
		assert.match(rendered, /已填：手打的一版方案/, "原答案还在");
	});
});

describe("历史条目", () => {
	it("选中历史会进编辑器并预填那段文本", async () => {
		const h = start();
		const c = await drive(h.component, [KEYS.down, KEYS.down, KEYS.enter, "手打的一版方案", KEYS.enter, KEYS.enter]);
		backToQuestionOne(c);
		c.handleInput(KEYS.up); // 第 2 项
		c.handleInput(KEYS.up); // 第 1 项
		c.handleInput(KEYS.enter); // 出提示
		c.handleInput(KEYS.enter); // 确认改选 → 历史里有了那条
		backToQuestionOne(c);

		c.handleInput(KEYS.down); // 第 2 项
		c.handleInput(KEYS.down); // Type something.
		c.handleInput(KEYS.down); // 历史 1
		assert.match(highlighted(c), /↺ 之前输入 1/);
		c.handleInput(KEYS.enter); // 进编辑器
		const rendered = lines(c).join("\n");
		assert.match(rendered, /Your answer:/, "应进编辑器模式");
		assert.match(rendered, /手打的一版方案/, "编辑器里要预填那段文本");
	});
});

describe("答案在提交流程里仍然正确", () => {
	it("确认换选项之后，最终答案是换过的那一项", async () => {
		const h = start();
		const c = await drive(h.component, [KEYS.down, KEYS.down, KEYS.enter, "手打的一版方案", KEYS.enter, KEYS.enter]);
		backToQuestionOne(c);
		c.handleInput(KEYS.up);
		c.handleInput(KEYS.up);
		c.handleInput(KEYS.enter); // 提示
		c.handleInput(KEYS.enter); // 确认 → 回到 q2（已答）→ 再切到提交页
		c.handleInput(KEYS.tab); // q2 → 提交页
		c.handleInput(KEYS.enter); // 提交
		const result = await h.result;
		const answer = result.details.answers.find((a) => a.id === "q1");
		assert.equal(result.details.cancelled, false);
		assert.equal(answer?.value, "worktree");
		assert.equal(answer?.wasCustom, false);
	});
});
