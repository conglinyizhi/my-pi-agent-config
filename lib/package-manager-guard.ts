// lib/package-manager-guard.ts — 把 npm / npx / yarn 从命令里挑出来
//
// 为什么要有硬拦：worker 的系统提示（lib/subagent-run.ts 的「工具链边界」）里已经写了
// 「装包卸包一律 pnpm、一次性 CLI 用 pnpm dlx、禁止 npm 与 yarn」，但提示只影响模型的
// 选择，挡不住它真去跑。npm install 会在工程里再落一份 node_modules 与 package-lock.json，
// 跟已有的 pnpm-lock.yaml 打架；npx 另拉一套依赖树，装出来的跟工程不是同一份。
//
// 判据只看每个命令段的**首词**（commandWordOf 已经跳过 env 赋值、sudo/env 这类包装器
// 与引号里的 token），所以 `ls ~/.pi/agent/npm/xxx` 这种路径里的 npm 不会误伤。

import { commandWordOf, splitWithSeparators } from "../extensions/sandbox-permissions/scanner.ts";

/**
 * 要拦下的包管理器。
 * bun 不在此列：它是另一个运行时，不属于「跟 pnpm 抢同一份依赖树」这件事，
 * 而且真要用它时拦下来反而挡住正经活儿。
 */
const BANNED = ["npm", "npx", "yarn"];

/** 命令里第一个被拦下的包管理器名；没有就返回 undefined */
export function findForeignPackageManager(command: string): string | undefined {
	if (typeof command !== "string" || command === "") return undefined;
	for (const { seg } of splitWithSeparators(command)) {
		const word = commandWordOf(seg);
		if (word === "") continue;
		const base = word.split("/").pop()?.toLowerCase() ?? "";
		if (BANNED.includes(base)) return base;
	}
	return undefined;
}

/** 拒绝时给 worker 看的文案：说清拦了什么、该换成什么、为什么 */
export function foreignPackageManagerMessage(found: string): string {
	return [
		`worker 的包管理器边界：这条命令里的 ${found} 被拦下了，请改用 pnpm 重试`,
		``,
		`  装包卸包：pnpm install / pnpm add <包> / pnpm remove <包>`,
		`  一次性 CLI：pnpm dlx <包>（替代 npx）`,
		`  工程脚本：pnpm run <script>；执行本地依赖的 CLI：pnpm exec <程序>`,
		``,
		`npm 与 yarn 会在工程里另落一份依赖树与 lock 文件，跟已有的 pnpm-lock.yaml 打架，`,
		`装出来的东西跟工程不是同一份。`,
	].join("\n");
}
