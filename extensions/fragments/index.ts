// extensions/fragments/index.ts — 输入框里的 &碎片
//
// 四件事：
//   1 提交前展开：`&单步计划` 在你按回车后换成 fragments.toml 里那段正文（input 事件，只动你自己的输入）
//     另外 `&名字(参数)` 交给注册的 provider 展开（动态内容，可以带回图片），见 lib/fragment-providers.ts
//   2 /frag:build <名字>：把正文插进输入框，改完再发
//   3 /frag:list：列出全部碎片，选中即插入
//   4 /frag:add：两个 TUI（先「名字 描述」再正文）加一条，追加进配置
// 另外输入 `&` 时自动弹候选（autocomplete）。
//
// 配置在 ~/.pi/agent/fragments.toml（独立文件，不跟 extensions.toml 挤）：
//   [[fragment]]
//   name = "单步计划"
//   desc = "仅调查不行动"
//   text = """
//   对于这一步，只做调查、不要动手；先给证据与结论，等我点头再动。
//   """
//
// 生效要 /reload。配置改动不用 reload：每次用的时候按 mtime 判断要不要重读。

import { statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	addFragmentToFile,
	checkFragmentName,
	expandFragmentsAsync,
	findFragment,
	loadFragments,
	triggerNames,
	type Fragment,
	type FragmentFile,
} from "./core.ts";

const CONFIG_NAME = "fragments.toml";

function configPath(): string {
	return join(getAgentDir(), CONFIG_NAME);
}

// ── 读配置：按 mtime 缓存，改了文件下次输入就用新的 ──

let cache: { path: string; mtimeMs: number; file: FragmentFile } | undefined;

function currentFile(): FragmentFile {
	const path = configPath();
	let mtimeMs = -1;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		// 文件不在：mtimeMs 保持 -1，交给 loadFragments 判 missing
	}
	if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.file;
	const file = loadFragments(path);
	cache = { path, mtimeMs, file };
	return file;
}

/** 测试用：清掉按 mtime 的缓存 */
export function resetFragmentCache(): void {
	cache = undefined;
}

// ── 提示：同一条只提醒一次，别让每次输入都刷屏 ──

const told = new Set<string>();

/** 测试用：清掉「已提示过」的记录 */
export function resetFragmentNotices(): void {
	told.clear();
}

function tell(ctx: ExtensionContext, key: string, message: string, level: "info" | "warning" | "error"): void {
	if (told.has(key)) return;
	told.add(key);
	try {
		ctx.ui.notify(message, level);
	} catch {
		// 没有 UI（rpc / print）就算了：提示不是功能本身
	}
}

function reportProblems(ctx: ExtensionContext, file: FragmentFile): void {
	if (file.error) tell(ctx, `error:${file.error}`, file.error, "error");
	for (const problem of file.problems) tell(ctx, `problem:${problem}`, `${CONFIG_NAME}：${problem}`, "warning");
}

// ── 插进输入框（/frag:build 与 /frag:list 共用） ──

function labelOf(fragment: Fragment): string {
	const aliases = fragment.aliases ?? [];
	const aliasPart = aliases.length > 0 ? `（别名：${aliases.join("、")}）` : "";
	const descPart = fragment.desc ? ` — ${fragment.desc}` : "";
	return `${fragment.name}${aliasPart}${descPart}`;
}

/** 候选条目：主名与每个别名各一条，别名那条注明它属于谁 */
function autocompleteItemsFor(fragment: Fragment): Array<{ value: string; label: string; description: string }> {
	const fallback = fragment.desc ?? fragment.text.split("\n")[0].slice(0, 60);
	return triggerNames(fragment).map((key) => ({
		value: `&${key}`,
		label: `&${key}`,
		description: key === fragment.name ? fallback : `${fragment.name} 的别名`,
	}));
}

function insertIntoEditor(ctx: ExtensionContext, fragment: Fragment): void {
	const current = typeof ctx.ui.getEditorText === "function" ? ctx.ui.getEditorText() : "";
	const head = current.replace(/\s+$/, "");
	ctx.ui.setEditorText(head === "" ? fragment.text : `${head}\n${fragment.text}`);
	ctx.ui.notify(`已插入 &${fragment.name}，改完再发`, "info");
}

/** 「名字 描述」按第一个空白分开：名字不含空白，描述可省、可带空格 */
function splitFragmentSpec(raw: string): { name: string; desc: string } {
	const trimmed = raw.trim();
	const gap = trimmed.search(/\s/);
	if (gap === -1) return { name: trimmed, desc: "" };
	return { name: trimmed.slice(0, gap), desc: trimmed.slice(gap).trim() };
}

export default function (pi: ExtensionAPI): void {
	// 1 提交前展开。只认 interactive 来源：别人（rpc/扩展）发进来的文本不该被我们改写。
	// 展开是异步的：`&名字(参数)` 要问 provider（没注册 provider 就是不存在的名字，行为跟以前一样）。
	pi.on("input", async (event, ctx) => {
		try {
			if (event.source !== "interactive") return { action: "continue" };
			const file = currentFile();
			reportProblems(ctx, file);
			const result = await expandFragmentsAsync(event.text, file.fragments);
			for (const name of result.unknown) {
				const hint = file.missing
					? `还没有 ${configPath()}，&${name} 不会展开`
					: `没有 &${name} 这个碎片（/frag:list 看已定义的）`;
				tell(ctx, `unknown:${name}`, hint, "warning");
			}
			// provider 出错的调用原文还在文本里，这里只说一句为什么没展开
			for (const error of result.errors) tell(ctx, `expand-error:${error}`, error, "error");
			// 有图就一定要 transform：正文可能一个字没变，但图得附到这条消息上
			// pi 那边是拿返回值里的 images 整组替掉，所以原本就在这条输入上的图（比如粘的截图）要一起带回来
			if (result.images.length > 0) {
				return { action: "transform", text: result.text, images: [...(event.images ?? []), ...result.images] };
			}
			if (result.text === event.text) return { action: "continue" };
			return { action: "transform", text: result.text };
		} catch (err) {
			// 出岔子就当没这回事，绝不把用户的输入吞掉
			tell(ctx, `crash:${String(err)}`, `fragments 展开失败：${err instanceof Error ? err.message : String(err)}`, "error");
			return { action: "continue" };
		}
	});

	// 2 /frag:build <名字> —— 把正文插进输入框
	pi.registerCommand("frag:build", {
		description: "把某个 &碎片 的正文插进输入框（可改完再发）",
		handler: async (args, ctx) => {
			const file = currentFile();
			reportProblems(ctx, file);
			const name = (args ?? "").trim();
			if (name === "") {
				ctx.ui.notify("用法：/frag:build <名字>；想看全部名字用 /frag:list", "info");
				return;
			}
			const fragment = findFragment(file.fragments, name);
			if (!fragment) {
				const hint = file.missing ? `（还没有 ${configPath()}）` : "（/frag:list 看已定义的）";
				ctx.ui.notify(`没有 ${name} 这个碎片${hint}`, "warning");
				return;
			}
			insertIntoEditor(ctx, fragment);
		},
	});

	// 3 /frag:list —— 列表并选中插入
	pi.registerCommand("frag:list", {
		description: "列出全部 &碎片（选中即插入输入框）",
		handler: async (_args, ctx) => {
			const file = currentFile();
			reportProblems(ctx, file);
			if (file.fragments.length === 0) {
				ctx.ui.notify(file.missing ? `还没有 ${configPath()}（照 README 里那段写就行）` : `${CONFIG_NAME} 里还没有碎片`, "info");
				return;
			}
			const labels = file.fragments.map(labelOf);
			if (typeof ctx.ui.select !== "function" || !ctx.hasUI) {
				ctx.ui.notify(labels.join(" · "), "info");
				return;
			}
			const picked = await ctx.ui.select(`碎片（${file.fragments.length} 条）`, labels);
			if (!picked) return;
			const fragment = file.fragments[labels.indexOf(picked)];
			if (fragment) insertIntoEditor(ctx, fragment);
		},
	});

	// 4 /frag:add —— 两个 TUI 加一条：先「名字 描述」，再正文，写完直接落进配置
	pi.registerCommand("frag:add", {
		description: "加一条碎片：先填「名字 描述」（描述可省），再写正文，追加进 fragments.toml",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(`没有可用的交互界面（rpc / print），/frag:add 用不了；直接编辑 ${configPath()} 加一段 [[fragment]] 也一样`, "warning");
				return;
			}
			const file = currentFile();
			reportProblems(ctx, file);
			const head = await ctx.ui.input("新碎片：名字 描述（描述可省；第一个空白分开）", "例如：关于我 背景资料入口");
			if (head === undefined) return; // 第一个 TUI 取消了
			const { name, desc } = splitFragmentSpec(head);
			// 名字先在本地过一遍：不合适就别让人白写一通正文
			const nameProblem = checkFragmentName(name, file.fragments);
			if (nameProblem !== undefined) {
				ctx.ui.notify(`没写入：${nameProblem}`, "warning");
				return;
			}
			const text = await ctx.ui.editor(`&${name.trim()} 的正文（多行随意；空的不收）`, "");
			if (text === undefined) return; // 第二个 TUI 取消了
			const result = addFragmentToFile(configPath(), { name, desc, text });
			if (!result.ok) {
				ctx.ui.notify(`${CONFIG_NAME} 没动：${result.reason}`, "warning");
				return;
			}
			resetFragmentCache(); // 配置按 mtime 缓存，刚写完直接失效，免得同一毫秒里还读到旧的
			ctx.ui.notify(`已写入 &${result.fragment.name}（${configPath()}），打 &${result.fragment.name} 就能用`, "info");
		},
	});

	// 5 输入 `&` 时的候选
	pi.on("session_start", (_event, ctx) => {
		try {
			ctx.ui.addAutocompleteProvider((current) => ({
				// 开头的 `&` 就是补全的触发字符：pi 会把它合并进触发集，打了就自动弹（不必手动按 Tab）
				triggerCharacters: ["&"],
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					const line = lines[cursorLine] ?? "";
					const before = line.slice(0, cursorCol);
					// 名字字符集与 core.ts 的 NAME_CHAR 一套（含冒号）；带 `(` 之后就不弹了，参数自己打
					const match = /(?:^|\s)&([\p{L}\p{N}_:-]*)$/u.exec(before);
					if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
					const query = match[1] ?? "";
					const needle = query.toLowerCase();
					const items = currentFile()
						.fragments.flatMap(autocompleteItemsFor)
						.filter((item) => item.label.slice(1).toLowerCase().includes(needle))
						.slice(0, 20);
					if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
					return { items, prefix: `&${query}` };
				},
				applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				},
				shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
					return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
				},
			}));
		} catch {
			// 补全是锦上添花，接不上就算了
		}
	});
}
