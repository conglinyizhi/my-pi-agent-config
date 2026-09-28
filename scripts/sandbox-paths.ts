#!/usr/bin/env -S node --experimental-strip-types
// scripts/sandbox-paths.ts — 脱离 pi 会话也能改沙箱路径配置的入口
//
// 为什么要有它：`trustedProgramDirs`（可信程序目录）是**人类的权限** —— 该由人自己
// 确认或自己编译的产物才写进去。把它绑在「先开一个 pi 会话、再敲斜杠命令」上，
// 等于给这件事加了一道没必要的门；人想改配置时应该在终端里直接改。
//
// 这个脚本就是复用 `/sandbox:paths` 那套实现，只是把 ctx.ui 换成一个只会打印的假 ctx：
// 有 yad 就开窗（路径完全一样），yad 拉不起来就打印一句——**不会**退化成命令行问答，
// 因为它本来就是拿来点窗口的，没有窗口时用 `--args` 直接给参数更省事。
//
// 用法：
//   scripts/sandbox-paths.ts                    开窗（列出 + 菜单）
//   scripts/sandbox-paths.ts print              在终端里打印现状（不开窗）
//   scripts/sandbox-paths.ts list               开窗展示现状
//   scripts/sandbox-paths.ts add trusted /path  直接加（不开窗）
//   scripts/sandbox-paths.ts remove allow /path 直接删
//   scripts/sandbox-paths.ts help

import { pathsCommandHandler, type PathsCommandContext } from "../extensions/sandbox-permissions/paths-command.ts";
import { formatPathsList, loadAllLists, sandboxPathsFile } from "../extensions/sandbox-permissions/paths-config.ts";

const args = process.argv.slice(2).join(" ").trim();

// print：终端里看一眼现状。开窗那条路（list）在无图形环境里会一闪而过，
// 在终端里想核对配置的人要的是能选中、能复制的文本
if (args === "print" || args === "show") {
	process.stdout.write(`${formatPathsList(loadAllLists(), sandboxPathsFile())}\n`);
	process.exit(0);
}

const printed: string[] = [];
const ctx: PathsCommandContext = {
	hasUI: true, // 让 yad 那条路可走；没有图形时 yad-paths 自己会判 DISPLAY
	ui: {
		notify: (message: string, level?: string) => {
			printed.push(message);
			const tag = level && level !== "info" ? `[${level}] ` : "";
			process.stdout.write(`${tag}${message}\n`);
		},
		// 回退通道在这里故意不可用：这个脚本的定位是「点窗口」或「直接给参数」。
		// 交互式的一问一答留给 pi 里的 /sandbox:paths（那里有真正的 TUI）。
		select: async () => undefined,
		input: async () => undefined,
		confirm: async () => false,
	},
} as PathsCommandContext;

await pathsCommandHandler(args, ctx);

// 没开窗也没明确要参数时，提示一句怎么用（免得以为脚本没干活）
const looksLikeBareRun = args.trim() === "";
if (looksLikeBareRun && printed.length === 0) {
	process.stdout.write("没有可用的图形界面。带参数直接用，例如：\n");
	process.stdout.write("  sandbox-paths.ts list\n");
	process.stdout.write("  sandbox-paths.ts add trusted ~/.pi/runtime\n");
}
