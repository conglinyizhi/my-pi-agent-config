// status-file.js — subagent 状态快照的取数（纯函数，不 import electron，便于单测）
//
// 为什么单独放：快照路径是多会话共存下的关键参数——每条 pi 会话一份快照，
// 窗口必须读自己被指定的那一份。写死一个全局路径，多开时看板窗显示的是别人的进度，
// 而且不会报错，只是"看着像卡住"。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 没指定时用的默认快照路径（与 Go 侧、扩展侧一致） */
export const DEFAULT_STATUS_PATH = join(homedir(), ".pi", "subagent-status.json");

/**
 * 实际要读哪份快照：窗口给了且文件在就用它，否则退回默认。
 * 回退不隐藏——requested 原样带回，谁都能看出读的不是最初要的那份。
 */
export function resolveStatusPath(requested) {
	if (typeof requested === "string" && requested.trim() !== "" && existsSync(requested)) return requested;
	return DEFAULT_STATUS_PATH;
}

/**
 * 读快照：返回 { path, content, requested, fellBack }。
 * 文件读不到时给空对象（不是抛异常）：看板窗宁可显示"暂无进度"，也不该白屏。
 */
export function readStatusSnapshot(requested) {
	const wants = typeof requested === "string" && requested.trim() !== "" ? requested : null;
	const path = resolveStatusPath(requested);
	let content = "{}";
	try {
		content = readFileSync(path, "utf8");
	} catch {
		content = "{}";
	}
	return { path, content, requested: wants, fellBack: wants !== null && wants !== path };
}
