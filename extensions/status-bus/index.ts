// status-bus — 状态栏总线扩展
//
// 把 ctx.ui 接入总线（session_start 时 attach，幂等），使所有扩展的
// setStatus / setWidget / setWorking* 写入都经过规范存储（store）+ 原生透传（TUI 目标）。
// 未来 web 目标通过 statusBus.subscribe() 接入同一份变更流，无需改这里。
//
// 已知边界：扩展加载顺序 = readdirSync（非字母序、不可控），attach 可能晚于少数
//   扩展的 session_start 首轮写入；这些初始状态不进 store（TUI 显示不受影响）。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statusBus, type StatusUI } from "../../lib/status-bus.ts";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// ctx.ui 在整个会话里是单例（ExtensionRunner.uiContext），包一层即可拦截全部后续写入。
		statusBus.attach(ctx.ui as unknown as StatusUI);
	});

	pi.on("session_shutdown", () => {
		statusBus.reset();
	});
}
