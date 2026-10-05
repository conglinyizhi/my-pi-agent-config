// 示例流程：把「判安全就放行」换掉，改成人人都要过闸门。
//
// 文件名以下划线开头，所以加载器会跳过它（_ 开头的都当草稿/模板）。
// 想真用：复制成 bash-pre.ts（覆盖内置那条），然后 /reload。

import type { ReviewKit } from "../lib/review-flow/kit.ts";

export default (kit: ReviewKit) =>
	kit.flow({
		id: "bash-pre",
		deadlineMs: 60_000,
		budget: { calls: 5 },
		nodes: [
			kit.node("chatreview", { id: "chat", next: "classify" }),
			kit.node("classifier", { id: "classify", after: ["chat"], next: "merge" }),
			kit.node("merge", { id: "merge", after: ["chat", "classify"], next: "gate" }),
			// 自动放行那一步被拿掉了：所有命令都落到人这儿
			kit.node("gate", { id: "gate", after: ["merge"] }),
		],
	});
