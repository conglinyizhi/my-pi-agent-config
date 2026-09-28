// repo-prompts/warnings.ts — 告警收集：factory 期攒着，会话起来再交给 ui 发
//
// 扩展在 factory 阶段（加载时）就可能发现问题：规则表坏了、一条规则都读不到、md 打不开。
// 那时候**没有 ctx**，用不了 ui.notify。
//
// 也不该用 console：pi 的 TUI 下 stderr 是它自己的地皮，扩展往里写字既可能打乱界面，
// 用户又多半看不到 —— 会话里给人看的提示要走 ui.notify。
//
// 所以：发现问题先攒在这儿（同一条只攒一次），session_start 时由 index.ts 取走发出去。
// 装配期（每轮求值）的告警也走这里，只是要等到下一个会话开始才出现在界面上；
// 想看当下的状态就用 /repo-prompts，它会把规则表与读取情况列出来。

const pending: string[] = [];
const seen = new Set<string>();

/** 记一条告警（同一条消息只记一次）。没有 UI 也能安全调用 */
export function noteWarning(message: string): void {
	if (seen.has(message)) return;
	seen.add(message);
	pending.push(message);
}

/** 取走攒下的告警（取完即清空队列；`seen` 保留，同一条消息在整个进程里只提示一次） */
export function takeWarnings(): string[] {
	return pending.splice(0, pending.length);
}

/** 仅供测试：清空队列与去重表 */
export function resetWarnings(): void {
	pending.length = 0;
	seen.clear();
}
