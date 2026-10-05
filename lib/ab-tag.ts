// ab-tag.ts — A/B 的压缩状态：每条产品线一个 tag
//
// 目录（每个组件一份）：
//   ~/.pi/runtime/<组件>/tag          一行：当前 tag（短 sha）
//   ~/.pi/runtime/<组件>/prev-tag     一行：上一个 tag（回退目标）
//   ~/.pi/runtime/<组件>/count        一行：干净授权往返计数
//   ~/.pi/runtime/<组件>/dir          一行：当前 tag 的产物目录名
//   ~/.pi/runtime/<组件>/promote.log  追加式流水（谁切的、为什么）
//
// 两件旧事在这一层被砍掉：四种槽（stable/previous/dev/head）、current 软链。
// 更新只有两条路：强制切，或攒满阈值自动切。

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/** 攒到这个数就自动切 */
export const PROMOTE_THRESHOLD = 5;

export interface AbState {
	/** 当前生效的 tag（短 sha） */
	tag: string;
	/** 上一个（回退目标） */
	prevTag: string;
	/** 已经打好、还没生效的候选：攒满 5 次干净往返就切到它 */
	candidate: string;
	/** 产物目录名（桥接期仍是 dev） */
	dir: string;
	count: number;
}

export interface PromoteEvent {
	event: "note" | "update" | "rollback";
	/** 计数流水的数字（bumpClean 记的就是它） */
	count?: string;
	outcome?: string;
	reason?: string;
	from?: string;
	to?: string;
	note?: string;
}

function readLine(path: string): string {
	try {
		return readFileSync(path, "utf8").split("\n")[0].trim();
	} catch {
		return "";
	}
}

function writeLine(path: string, value: string): void {
	writeFileSync(path, value + "\n", { mode: 0o600 });
}

export function stateOf(root: string): AbState {
	const count = Number.parseInt(readLine(join(root, "count")), 10);
	return {
		tag: readLine(join(root, "tag")),
		prevTag: readLine(join(root, "prev-tag")),
		candidate: readLine(join(root, "candidate")),
		dir: readLine(join(root, "dir")),
		count: Number.isFinite(count) ? count : 0,
	};
}

/** 切到一个新 tag：旧 tag 落到 prev-tag，计数归零。force 只影响日志里怎么写 */
export function setTag(root: string, tag: string, options: { dir?: string; note?: string; forced?: boolean } = {}): AbState {
	mkdirSync(root, { recursive: true });
	const before = stateOf(root);
	if (before.tag !== "" && before.tag !== tag) writeLine(join(root, "prev-tag"), before.tag);
	writeLine(join(root, "tag"), tag);
	if (options.dir) writeLine(join(root, "dir"), options.dir);
	writeLine(join(root, "count"), "0");
	appendLog(root, {
		event: "update",
		from: before.tag || undefined,
		to: tag,
		reason: options.forced ? "强制更新" : "自动更新",
		...(options.note ? { note: options.note } : {}),
	});
	return stateOf(root);
}

/** 登记一个候选：已经打好、等 5 次干净往返。强制更新直接调 setTag 越过这一步 */
export function setCandidate(root: string, tag: string, options: { note?: string } = {}): AbState {
	mkdirSync(root, { recursive: true });
	writeLine(join(root, "candidate"), tag);
	writeLine(join(root, "count"), "0");
	appendLog(root, { event: "note", outcome: "candidate", to: tag, ...(options.note ? { note: options.note } : {}) });
	return stateOf(root);
}

/** 回退到 prev-tag（看门狗与手动回退共用） */
export function rollback(root: string): AbState {
	const before = stateOf(root);
	if (before.prevTag === "") return before;
	writeLine(join(root, "tag"), before.prevTag);
	writeLine(join(root, "prev-tag"), before.tag);
	writeLine(join(root, "count"), "0");
	appendLog(root, { event: "rollback", from: before.tag, to: before.prevTag });
	return stateOf(root);
}

/** 记一次干净授权往返；到阈值就告诉调用方该切了（切不切由调用方定） */
export function bumpClean(root: string, threshold = PROMOTE_THRESHOLD): { count: number; promote: boolean } {
	mkdirSync(root, { recursive: true });
	const next = stateOf(root).count + 1;
	writeLine(join(root, "count"), String(next));
	appendLog(root, { event: "note", outcome: "clean", count: String(next), reason: "窗口给出结论" });
	return { count: next, promote: next >= threshold };
}

export function appendLog(root: string, entry: PromoteEvent): void {
	mkdirSync(root, { recursive: true });
	const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
	appendFileSync(join(root, "promote.log"), line + "\n");
}
