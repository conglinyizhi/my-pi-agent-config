// 最小形状：一个节点就是一个函数。没有边、没有编排，就是"云函数"。
//
// 文件名以下划线开头，加载器跳过（草稿/模板）。想真用：复制成 bash-pre.ts，然后 /reload。

import type { ReviewKit } from "../lib/review-flow/kit.ts";

export default (kit: ReviewKit) =>
	kit.flow({
		id: "bash-pre",
		nodes: [
			kit.custom("judge", async (ctx) => {
				const command = String(ctx.input.command ?? "");
				// 在这里写你的判定：想调自己的服务就 kit.my.judge(command)
				if (command.trim().startsWith("rm -rf")) {
					return { status: "ok", terminal: "deny", verdict: "deny", reason: "递归删除一律拦下" };
				}
				return { status: "abstain", reason: "拿不准，交给人" };
			}),
		],
	});
