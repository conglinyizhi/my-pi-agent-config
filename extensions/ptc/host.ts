// extensions/ptc/host.ts — 借宿主（正在跑的那个 pi）的 codemode 实现，把它改名成 run_code
//
// 为什么不自己写引擎：脚本执行那一套（QuickJS worker、嵌套调用、store、模型调用）
// 在 pi 内部，公开导出只有 createCodemodeExtension，而它的工具名写死是 codemode。
// 改名自建又不重写引擎，就只能在运行时定位正在跑的那个包，从它的 dist 里取模块。
//
// 定位走 process.argv[1]（pi 的入口，dist/bundle/cli.js），realpath 后向上找到
// pi-coding-agent 这一层。实测（2026-10-04，pi 1.0.2）：import.meta.resolve 不认
// jiti 的别名，在扩展里解析 "@earendil-works/pi-coding-agent" 会 MODULE_NOT_FOUND，
// 所以不能用它；argv[1] 与调用栈都能定位到宿主，argv 这条最直白。
//
// 拿不到宿主就明确报错，不退化成「静默注册一个什么都不做的工具」：这个工具存在的
// 意义就是执行脚本，注册一个假的只会让模型在错误的认知上继续跑。

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { PTC_TOOL_NAME, sanitizeExecutionReason } from "../../lib/ptc-reason.ts";

/** 宿主 codemode 模块里我们真正用到的那几个导出 */
export interface HostCodemodeModule {
	createCodemodeToolDefinition(options?: Record<string, unknown>): HostToolDefinition;
	createCodemodeDescription(tools: readonly unknown[], options?: Record<string, unknown>): string;
	CODEMODE_TOOL_NAME: string;
}

/** 宿主工具定义的形状（只列我们会碰的字段，其余原样透传） */
export interface HostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: unknown;
	exposure?: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	prepareLoadout?: (loadout: unknown) => LoadoutChanges | undefined;
	renderCall?: (args: any, theme: any, context: any) => unknown;
	renderResult?: (result: any, options: any, theme: any, context: any) => unknown;
	execute: (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
	[key: string]: unknown;
}

interface LoadoutChanges {
	descriptions?: Record<string, string>;
	hiddenDeclarations?: string[];
}

/** run_code 的入参：一段程序，外加它自己的理由 */
export const RUN_CODE_SCHEMA = Type.Object({
	description: Type.String({
		description:
			"这次程序调用的执行理由：这段程序要做什么、为什么。一句话，审核链会读它；" +
			"它与代码不符时会被按更高风险处理，所以写实情。",
	}),
	code: Type.String({
		description:
			"Raw JavaScript source. Top-level await and return work. " +
			'May start with a `// @options: {"max_output_tokens": 1000}` line.',
	}),
});

/** 工具目录里的一行（静态常量，进前缀就固定，别逐轮变化） */
export const RUN_CODE_SNIPPET =
	"Run JavaScript that calls other tools, stating in `description` why (the audit chain reads it)";

export const RUN_CODE_GUIDELINES = [
	"用 run_code 批量或串联多次工具调用、把大输出过滤成需要的那点内容，而不是逐条发调用；互不依赖的调用放在一次 run_code 里用 await Promise.allSettled([...]) 并发。",
	"run_code 的 description 是这次调用的执行理由：写清这段程序要做什么、为什么。它是声明不是证据——审核链拿代码对照，对不上会按更高风险处理。",
	"程序里派发的每个调用（bash / edit / …）都会带着这段理由进审核链，所以理由要能覆盖整段程序，不要只写第一步。",
	// 这条是官方那份没有的。注意别写成"要求超长字面量"——把一大段正文塞进一个字符串参数
	// 要转义换行与引号，是转义事故的高发区；要拦的是审核侧真推不出来的那类东西
	"写正文不必为了审核侧去凑超长字面量：数组 join、常量拼接都可以，那是为了少踩转义。真正要避免的是 eval / new Function / 动态拼工具名——那类东西审核侧推不出来，只能退到人工闸门。",
] as const;

/** 从 pi 的入口路径向上找到 pi-coding-agent 包根 */
export function hostPackageRoot(
	argv1: string | undefined,
	realpath: (path: string) => string = realpathSync,
): string | undefined {
	if (!argv1) return undefined;
	let dir: string;
	try {
		dir = dirname(realpath(argv1));
	} catch {
		// 路径不存在（探针/测试里常见）就按原样解析，不因为 realpath 失败放弃定位
		dir = dirname(argv1);
	}
	for (let i = 0; i < 8; i++) {
		if (basename(dir) === "pi-coding-agent") return dir;
		const next = dirname(dir);
		if (next === dir) return undefined;
		dir = next;
	}
	return undefined;
}

/**
 * 载入宿主的 codemode 模块。
 *
 * @param argv1 pi 的入口路径，缺省取 process.argv[1]
 * @param importModule 动态导入（测试可注入）
 */
export async function loadHostCodemode(
	argv1: string | undefined = process.argv[1],
	importModule: (url: string) => Promise<unknown> = (url) => import(url),
): Promise<HostCodemodeModule> {
	const root = hostPackageRoot(argv1);
	if (root === undefined) {
		throw new Error(`定位不到正在运行的 pi 包（process.argv[1] = ${argv1 ?? "空"}）`);
	}
	const target = join(root, "dist", "extensions", "codemode", "tool.js");
	if (!existsSync(target)) {
		throw new Error(`宿主 pi 里没有 ${target}（pi 的目录结构变了？）`);
	}
	const module = (await importModule(pathToFileURL(target).href)) as Partial<HostCodemodeModule>;
	if (typeof module.createCodemodeToolDefinition !== "function" || typeof module.createCodemodeDescription !== "function") {
		throw new Error(`${target} 里没有 createCodemodeToolDefinition / createCodemodeDescription`);
	}
	return module as HostCodemodeModule;
}

/**
 * 宿主 prepareLoadout 的结果换成我们的工具名。
 * 宿主那份把目录写在 "codemode" 名下，不改名的话我们的描述不会被替换，模型看到的是空壳。
 */
function remapLoadout(changes: LoadoutChanges | undefined, hostName: string): LoadoutChanges | undefined {
	if (changes === undefined) return undefined;
	const descriptions = { ...(changes.descriptions ?? {}) };
	const hostDescription = descriptions[hostName];
	if (hostDescription !== undefined) {
		delete descriptions[hostName];
		descriptions[PTC_TOOL_NAME] = hostDescription;
	}
	return { ...changes, descriptions };
}

/** 折叠时一行截断，展开时整段；理由是给审核看的一句话，不该在默认视图里把代码挤下去 */
function reasonComponent(reason: string, theme: any, context: any) {
	const line = theme.fg("muted", `理由：${reason}`);
	return context?.expanded === true ? new Text(line, 0, 0) : new TruncatedText(line, 0, 0);
}

/**
 * 标题改名的两种写法，各挡一种宿主形态：
 * - **主题代理**：官方 renderCall 里 `theme.bold("codemode")` 是唯一一处标题来源，
 *   换掉入参即可（pi 0.99 的单个 Text 形态只能靠这个）
 * - **改写第一个孩子**：pi 1.0.2 的 renderCall 把标题单独做成一个 Text 子组件，
 *   直接 setText 更稳（不怕将来标题不走 bold）
 */
function titledTheme(theme: any, officialName: string): any {
	return new Proxy(theme, {
		get(target, key, receiver) {
			if (key === "bold") {
				return (text: string) => target.bold(text === officialName ? PTC_TOOL_NAME : text);
			}
			const value = Reflect.get(target, key, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * 调用行的呈现：**沿用官方 renderCall**（代码高亮、折叠提示、展开行为都跟着官方走），
 * 只动两处 —— 换掉写死的标题，并在标题下面插一行理由。
 *
 * 宿主形态按版本分两种，都覆盖：
 * - pi 1.0.2：返回 Container，孩子是 [标题, 代码预览…] → 在第 1 位插入理由
 * - pi 0.99：标题和代码在同一个 Text 里，插不进中间 → 理由放它上面
 */
function renderCall(
	hostDefinition: HostToolDefinition,
	args: { description?: unknown; code?: unknown },
	theme: any,
	context: any,
	officialName: string,
) {
	const reason = sanitizeExecutionReason(args?.description);
	const official = hostDefinition.renderCall?.(args, titledTheme(theme, officialName), context) as
		| { children?: unknown[] }
		| undefined;

	// 鸭子判定，不用 instanceof：宿主 bundle 里的 Container 与我们导入的不是同一个类副本，
	// instanceof 会假阴性。「有可变的 children 数组」就是能插孩子的组件。
	const children = official?.children;
	if (Array.isArray(children) && children.length > 0) {
		const title = children[0] as { setText?: (text: string) => void };
		if (typeof title?.setText === "function") title.setText(theme.fg("toolTitle", theme.bold(PTC_TOOL_NAME)));
		if (reason !== undefined) children.splice(1, 0, reasonComponent(reason, theme, context));
		return official;
	}

	const component = new Container();
	if (reason !== undefined) component.addChild(reasonComponent(reason, theme, context));
	if (official !== undefined) component.addChild(official as never);
	else component.addChild(new Text(theme.fg("toolTitle", theme.bold(PTC_TOOL_NAME)), 0, 0));
	return component;
}

export interface RunCodeDefinitionOptions {
	/** 暴露 models 命名空间（脚本里的 models.*）。缺省 true，与内置 codemode 一致 */
	models?: boolean;
	getMode?: () => string;
	getInlineBudget?: () => number | undefined;
}

/**
 * 组装 run_code 的工具定义：拿宿主的定义，换名字、换入参、换理由呈现，
 * 引擎、嵌套调用、store、loadout 目录的生成全部沿用宿主那一份。
 */
export function buildRunCodeDefinition(host: HostCodemodeModule, options: RunCodeDefinitionOptions = {}): HostToolDefinition {
	const hostDefinition = host.createCodemodeToolDefinition({
		models: options.models ?? true,
		getMode: options.getMode,
		getInlineBudget: options.getInlineBudget,
	});
	const definition: HostToolDefinition = {
		...hostDefinition,
		name: PTC_TOOL_NAME,
		label: PTC_TOOL_NAME,
		// 描述在激活时由 prepareLoadout 换成「可调用工具的目录」，这里给的是未激活时的底稿
		description: host.createCodemodeDescription([], { models: options.models ?? true }),
		parameters: RUN_CODE_SCHEMA,
		promptSnippet: RUN_CODE_SNIPPET,
		promptGuidelines: [...RUN_CODE_GUIDELINES],
		// 与 codemode 同一条纪律：脚本不能再开脚本（model-only 只声明给模型，不可被脚本调用）
		exposure: "model-only",
		prepareLoadout: (loadout: unknown) => remapLoadout(hostDefinition.prepareLoadout?.(loadout), host.CODEMODE_TOOL_NAME),
		renderCall: (args: { description?: unknown; code?: unknown }, theme: any, context: any) =>
			renderCall(hostDefinition, args, theme, context, host.CODEMODE_TOOL_NAME),
	};
	// 宿主的 grammar 是给「纯源码文本」写的，我们的入参是两个字段的对象，不能带
	delete definition.constrainedSampling;
	return definition;
}
