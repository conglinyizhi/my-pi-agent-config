// extensions/fragments/index.ts — 输入框里的 &碎片
//
// 三件事：
//   1 提交前展开：`&单步计划` 在你按回车后换成 fragments.toml 里那段正文（input 事件，只动你自己的输入）
//   2 /frag:build <名字>：把正文插进输入框，改完再发
//   3 /frag:list：列出全部碎片，选中即插入
// 另外输入 `&` 时弹候选（autocomplete）。
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
import { expandFragments, findFragment, loadFragments, triggerNames, type Fragment, type FragmentFile } from "./core.ts";

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

export default function (pi: ExtensionAPI): void {
	// 1 提交前展开。只认 interactive 来源：别人（rpc/扩展）发进来的文本不该被我们改写。
	pi.on("input", (event, ctx) => {
		try {
			if (event.source !== "interactive") return { action: "continue" };
			const file = currentFile();
			reportProblems(ctx, file);
			const result = expandFragments(event.text, file.fragments);
			for (const name of result.unknown) {
				const hint = file.missing
					? `还没有 ${configPath()}，&${name} 不会展开`
					: `没有 &${name} 这个碎片（/frag:list 看已定义的）`;
				tell(ctx, `unknown:${name}`, hint, "warning");
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

	// 4 输入 `&` 时的候选
	pi.on("session_start", (_event, ctx) => {
		try {
			ctx.ui.addAutocompleteProvider((current) => ({
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					const line = lines[cursorLine] ?? "";
					const before = line.slice(0, cursorCol);
					const match = /(?:^|\s)&([\p{L}\p{N}_-]*)$/u.exec(before);
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
