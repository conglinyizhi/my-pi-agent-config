// lib/worker-ptc-approval.test.ts — worker 里 run_code 的审批两条出路
// 跑法：node --experimental-strip-types lib/worker-ptc-approval.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { approvePtcScriptInWorker } from "./worker-ptc-approval.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-worker-ptc-"));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const script = "const r = await tools.read({ path: '/tmp/x' });\nreturn r;";

function call(over: {
	preReview: () => Promise<{ autoApproved: boolean; review?: { verdict: string; reason?: string } }>;
	requestPath?: string;
	responsePath?: string;
}) {
	return approvePtcScriptInWorker({
		pi: {} as never,
		ctx: { cwd: "/tmp" } as never,
		input: { script, reason: "读一下" } as never,
		deps: {
			preReview: over.preReview as never,
			requestPath: over.requestPath,
			responsePath: over.responsePath,
		},
	});
}

describe("worker 里 run_code 的审批", () => {
	it("预审判 safe 且档位 auto：直接放行，不写任何请求", async () => {
		const requestPath = join(dir, "never-request.json");
		const outcome = await call({
			preReview: async () => ({ autoApproved: true, review: { verdict: "safe", reason: "只读" } }),
			requestPath,
			responsePath: join(dir, "never-response.json"),
		});
		assert.equal(outcome.approved, true);
		assert.equal(outcome.review?.verdict, "safe");
		assert.equal(existsSync(requestPath), false, "自动放行不该惊动父进程");
	});

	it("没有审批通道时明确拒绝，不假装执行", async () => {
		const outcome = await call({
			preReview: async () => ({ autoApproved: false }),
			requestPath: "",
			responsePath: "",
		});
		assert.equal(outcome.approved, false);
		assert.match(outcome.comment ?? "", /审批响应通道/);
	});

	it("判不出安全：写请求等父进程，获批后带上附言", async () => {
		const requestPath = join(dir, "req.json");
		const responsePath = join(dir, "res.json");
		const pending = call({
			preReview: async () => ({ autoApproved: false, review: { verdict: "risky", reason: "会写工作区外" } }),
			requestPath,
			responsePath,
		});

		// 请求是同步写出来的，轮询到它就拿到了 requestId
		let requestId = "";
		for (let i = 0; i < 100 && requestId === ""; i += 1) {
			try {
				requestId = String((JSON.parse(readFileSync(requestPath, "utf8")) as { requestId?: string }).requestId ?? "");
			} catch {
				await sleep(20);
			}
		}
		assert.notEqual(requestId, "", "应该写出 capability 请求");
		writeFileSync(responsePath, JSON.stringify({ requestId, action: "allow", comment: "只许读" }));

		const outcome = await pending;
		assert.equal(outcome.approved, true);
		assert.equal(outcome.comment, "只许读");
	});

	it("被判 risky 且父进程拒绝：不执行，理由带回来", async () => {
		const requestPath = join(dir, "req-deny.json");
		const responsePath = join(dir, "res-deny.json");
		const pending = call({
			preReview: async () => ({ autoApproved: false, review: { verdict: "risky" } }),
			requestPath,
			responsePath,
		});

		let requestId = "";
		for (let i = 0; i < 100 && requestId === ""; i += 1) {
			try {
				requestId = String((JSON.parse(readFileSync(requestPath, "utf8")) as { requestId?: string }).requestId ?? "");
			} catch {
				await sleep(20);
			}
		}
		writeFileSync(responsePath, JSON.stringify({ requestId, action: "deny", comment: "别碰 /etc" }));

		const outcome = await pending;
		assert.equal(outcome.approved, false);
		assert.equal(outcome.comment, "别碰 /etc");
	});
});
