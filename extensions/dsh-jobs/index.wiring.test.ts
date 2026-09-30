// index.wiring.test.ts —— dsh-jobs 接线冒烟测试
//
// 跑法：node --test --experimental-strip-types extensions/dsh-jobs/index.wiring.test.ts
//
// 为什么单独测「接线」：index.ts 是扩展入口，只有 pi 真正加载时才会执行，
// 其余测试都只测它下面的纯逻辑模块。于是入口里任何一处写错（漏 import、
// 名字打错、在回调里调不存在的函数）都能溜过全部测试与类型检查以外的关卡，
// 直到会话跑起来才炸。这个文件把入口装一次，让它当场崩。
//
// 探针必须把定时器真的放出来跑：漏掉的引用如果在心跳/延迟回调里（真发生过，
// 是节流推送那一层），只调一次 default(pi) 是发现不了的。

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ownerFileName, type OwnerInfo } from "./snapshot.ts";

// 状态目录指到临时目录：接线测试也不该碰真运行时目录里的快照
const stateDir = mkdtempSync(join(tmpdir(), "dsh-jobs-wiring-"));
process.env.PI_JOB_STATE_DIR = stateDir;
// hub socket 指到不存在的路径：推送走「连不上就静默返回 false」的正常降级分支，
// 既覆盖了这段代码，又不会真去敲用户的 hub
process.env.PI_HUB_SOCKET = join(stateDir, "no-such-hub.sock");

after(() => rmSync(stateDir, { recursive: true, force: true }));

/** 只实现入口用到的那几个方法：够 default(pi) 跑完装配即可 */
function fakePi() {
	const events: string[] = [];
	const commands: string[] = [];
	const tools: string[] = [];
	return {
		events,
		commands,
		tools,
		api: {
			on: (name: string) => {
				events.push(name);
			},
			registerTool: (tool: { name: string }) => {
				tools.push(tool.name);
			},
			registerCommand: (name: string) => {
				commands.push(name);
			},
			sendMessage: () => {},
		},
	};
}

describe("dsh-jobs 入口接线", () => {
	let pi: ReturnType<typeof fakePi>;

	before(async () => {
		const mod = await import("./index.ts");
		assert.equal(typeof mod.default, "function", "扩展入口应当导出 default 函数");
		pi = fakePi();
		// 装配：漏 import / 名字打错会在这里当场抛
		mod.default(pi.api as never);
	});

	it("装配了工具、命令与订阅的事件", () => {
		assert.deepEqual(pi.tools, ["bash_background", "job_output", "job_list", "job_kill"]);
		assert.ok(pi.commands.includes("jobs"), "/jobs 面板命令");
		assert.ok(pi.commands.includes("jobs:kill"), "/jobs:kill 直通命令");
		assert.ok(pi.commands.includes("dsh-jobs"), "旧命令名保留");
		assert.ok(pi.events.includes("session_start"));
		assert.ok(pi.events.includes("session_shutdown"));
	});

	it("放定时器跑一阵：心跳与节流回调里的引用也是活的", async () => {
		// 心跳 1s 一拍，节流推送 200ms；跨过几拍，让两处回调都真的执行
		const errors: unknown[] = [];
		const onError = (err: unknown) => errors.push(err);
		process.on("uncaughtException", onError);
		await new Promise((r) => setTimeout(r, 2_500));
		process.off("uncaughtException", onError);
		assert.deepEqual(errors, [], `回调里抛了未捕获错误：${errors.map(String).join("; ")}`);
	});
});

describe("快照文件名规则", () => {
	// 推送 payload 报的就是这个名字，面板据此重读目录；规则改动要在这里同步体现
	it("主进程与 worker 各自的文件名", () => {
		const main: OwnerInfo = { kind: "main", pid: 1234, cwd: "/tmp", label: "主进程" };
		const worker: OwnerInfo = { kind: "worker", pid: 5678, taskId: "batch-x/w1", cwd: "/tmp", label: "worker w1" };
		assert.equal(ownerFileName(main), "owner-main-1234.json");
		// taskId 是外部数据，路径分隔符必须被替换掉
		assert.equal(ownerFileName(worker), "owner-worker-batch-x_w1-5678.json");
	});
});
