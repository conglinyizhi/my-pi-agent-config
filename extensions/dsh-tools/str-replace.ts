// str-replace.ts — DSH dsh-tool-str-replace-editor 移植：行号定位编辑工作流
//
// 语义照抄 @deepseek-ai/dsh-tool-str-replace-editor：
//   - command: view | create | str_replace | insert
//   - view：cat -n 行号视图 + view_range（[start, end]，end=-1 到文件尾）；目录列出 2 层
//   - create：拒绝已存在文件
//   - str_replace：old_str 必须精确匹配且唯一（0 次/多次都拒绝执行并说明）
//   - insert：在 insert_line 之后插入 new_str
//   - 输出超过 maxOutputChars（默认 16000）截断并标注 <response clipped>
//
// 与 pi 内建工具的分工（工具描述引导）：view 的行号 + insert 的行号定位是 pi read/edit
// 没有的编辑范式；str_replace 与 pi edit 等价（都要求唯一匹配）——模型可自行选择。
//
// 纯函数（matchOffsets/lineNumbersAt/formatFileView/…）导出供单测；fs 操作用 node:fs
// 同步 API（扩展与宿主同权限，无 sandbox seam；路径要求绝对）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, dirname, join } from "node:path";

export const TRUNCATED_MESSAGE =
	"<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";

export const DEFAULT_MAX_OUTPUT_CHARS = 16000;

export type EditorCommand = "view" | "create" | "str_replace" | "insert";

// ---------------------------------------------------------------------------
// 纯函数（照抄 DSH）
// ---------------------------------------------------------------------------

export function maybeTruncate(content: string, maxOutputChars: number): string {
	return content.length <= maxOutputChars ? content : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE;
}

/** 全部匹配偏移（DSH matchOffsets） */
export function matchOffsets(content: string, search: string): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (;;) {
		const match = content.indexOf(search, offset);
		if (match < 0) return offsets;
		offsets.push(match);
		offset = match + search.length;
	}
}

/** 各偏移所在行号（1-indexed，DSH lineNumbersAt） */
export function lineNumbersAt(content: string, offsets: number[]): number[] {
	let line = 1;
	let cursor = 0;
	return offsets.map((offset) => {
		while (cursor < offset) {
			if (content[cursor] === "\n") line += 1;
			cursor += 1;
		}
		return line;
	});
}

/** 校验 view_range 并返回 [initialLine, finalLine]（finalLine=-1 表示到文件尾） */
export function normalizeViewRange(
	viewRange: number[] | undefined,
	allLines: string[],
): { initialLine: number; finalLine: number } | undefined {
	if (viewRange === undefined) return undefined;
	if (viewRange.length !== 2 || !viewRange.every(Number.isInteger)) {
		throw new Error("Invalid `view_range`. It should be a list of two integers.");
	}
	const [initialLine, finalLine] = viewRange;
	if (initialLine < 1 || initialLine > allLines.length) {
		throw new Error(
			`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
		);
	}
	if (finalLine > allLines.length) {
		throw new Error(
			`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
		);
	}
	if (finalLine !== -1 && finalLine < initialLine) {
		throw new Error(
			`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
		);
	}
	return { initialLine, finalLine };
}

/** cat -n 风格行号视图（DSH formatFileView） */
export function formatFileView(
	path: string,
	content: string,
	maxOutputChars: number,
	viewRange: number[] | undefined,
): string {
	const allLines = content.split("\n");
	const range = normalizeViewRange(viewRange, allLines);
	let lines = allLines;
	let initialLine = 1;
	let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;
	if (range) {
		initialLine = range.initialLine;
		lines = range.finalLine === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, range.finalLine);
		prompt += ` with view_range=[${range.initialLine}, ${range.finalLine}]`;
	}
	const numbered = lines.map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`).join("\n");
	return maybeTruncate(`${prompt}:\n${numbered}\n`, maxOutputChars);
}

/** 目录列出 2 层深（排除隐藏/node_modules/__pycache__，路径排序，DSH listDirectory） */
export function listDirectory(dirPath: string, maxOutputChars: number): string {
	function visit(dir: string, depth: number): string[] {
		const rows: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
			const full = join(dir, entry.name);
			const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?";
			rows.push(`${type}\t${full}`);
			if (entry.isDirectory() && depth < 2) rows.push(...visit(full, depth + 1));
		}
		return rows;
	}
	const rows = [`d\t${dirPath}`, ...visit(dirPath, 1)];
	rows.sort((a, b) => (a.slice(a.indexOf("\t") + 1) < b.slice(b.indexOf("\t") + 1) ? -1 : 1));
	const listing = maybeTruncate(rows.join("\n") + "\n", maxOutputChars);
	return `Here're the files and directories up to 2 levels deep in ${dirPath}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}

// ---------------------------------------------------------------------------
// fs 操作（node:fs 同步）
// ---------------------------------------------------------------------------

function requireAbsolute(path: string): string {
	if (typeof path !== "string" || path.trim().length === 0) {
		throw new Error("path must be a non-empty string");
	}
	if (!isAbsolute(path)) {
		throw new Error(`The path ${path} is not an absolute path, it should start with \`/\`. Maybe you meant /${path}?`);
	}
	return path;
}

function statExistingFile(path: string, command: EditorCommand): { isFile: boolean; isDir: boolean } {
	if (!existsSync(path)) {
		throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
	}
	const st = statSync(path);
	const isDir = st.isDirectory();
	if (isDir && command !== "view") {
		throw new Error(`The path ${path} is a directory and only the \`view\` command can be used on directories`);
	}
	if (!isDir && !st.isFile() && command !== "view") {
		throw new Error(`cannot edit "${path}": not a regular file`);
	}
	return { isFile: st.isFile(), isDir };
}

function required(value: unknown, parameter: string, command: EditorCommand, allowEmpty = true): string {
	if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`);
	if (!allowEmpty && (typeof value !== "string" || value.length === 0)) {
		throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`);
	}
	return value as string;
}

// ---------------------------------------------------------------------------
// 各命令
// ---------------------------------------------------------------------------

export function viewPath(path: string, viewRange: number[] | undefined, maxOutputChars: number): string {
	const target = requireAbsolute(path);
	const { isFile, isDir } = statExistingFile(target, "view");
	if (isDir) {
		if (viewRange !== undefined) throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
		return listDirectory(target, maxOutputChars);
	}
	if (!isFile) throw new Error(`cannot view "${target}": not a regular file or directory`);
	const content = readFileSync(target, "utf8");
	return formatFileView(target, content, maxOutputChars, viewRange);
}

export function createFile(path: string, fileText: string | undefined): string {
	const target = requireAbsolute(path);
	const content = required(fileText, "file_text", "create");
	if (existsSync(target)) {
		throw new Error(`File already exists at: ${target}. Cannot overwrite files using command \`create\`.`);
	}
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content, "utf8");
	return `New file created successfully at: ${target}`;
}

export function strReplace(path: string, oldStr: string | undefined, newStr: string | undefined): string {
	const target = requireAbsolute(path);
	const oldValue = required(oldStr, "old_str", "str_replace", false);
	const newValue = newStr ?? "";
	statExistingFile(target, "str_replace");
	const before = readFileSync(target, "utf8");
	const offsets = matchOffsets(before, oldValue);
	const offset = offsets[0];
	if (offset === undefined) {
		throw new Error(
			`No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${target}.`,
		);
	}
	if (offsets.length > 1) {
		throw new Error(
			`No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lineNumbersAt(before, offsets).join(", ")}]. Please ensure it is unique`,
		);
	}
	writeFileSync(target, before.slice(0, offset) + newValue + before.slice(offset + oldValue.length), "utf8");
	return `The file ${target} has been edited successfully.`;
}

export function insertLine(path: string, insertLineNum: number | undefined, newStr: string | undefined): string {
	const target = requireAbsolute(path);
	if (insertLineNum === undefined) throw new Error("Parameter `insert_line` is required for command: insert");
	const value = required(newStr, "new_str", "insert");
	statExistingFile(target, "insert");
	const lines = readFileSync(target, "utf8").split("\n");
	if (!Number.isInteger(insertLineNum) || insertLineNum < 0 || insertLineNum > lines.length) {
		throw new Error(
			`Invalid \`insert_line\` parameter: ${insertLineNum}. It should be within the range of lines of the file: [0, ${lines.length}]`,
		);
	}
	const after = [...lines.slice(0, insertLineNum), ...value.split("\n"), ...lines.slice(insertLineNum)].join("\n");
	writeFileSync(target, after, "utf8");
	return `The file ${target} has been edited successfully.`;
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = `
Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
`.trim();

export interface StrReplaceEditorOptions {
	/** 输出截断上限（默认 16000） */
	maxOutputChars?: number;
}

/** 注册 str_replace_editor 工具 */
export function registerStrReplaceEditor(
	pi: ExtensionAPI,
	options: StrReplaceEditorOptions = {},
): void {
	const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

	pi.registerTool({
		name: "str_replace_editor",
		label: "Str Replace Editor",
		description: TOOL_DESCRIPTION,
		promptSnippet: "View with line numbers and edit files via view/create/str_replace/insert commands",
		promptGuidelines: [
			"str_replace_editor 是行号定位编辑工作流：先 view 拿行号，再用 insert/str_replace 精确修改",
			"str_replace 的 old_str 必须唯一匹配，不唯一时拒绝执行——先用 view 或 grep -n 确认上下文",
			"与 pi 内建 read/edit 分工：read/edit 是文本定位；需要行号或按行插入时用 str_replace_editor",
		],
		parameters: Type.Object({
			command: Type.Union(
				[Type.Literal("view"), Type.Literal("create"), Type.Literal("str_replace"), Type.Literal("insert")],
				{ description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`." },
			),
			path: Type.String({ description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`." }),
			file_text: Type.Optional(
				Type.String({ description: "Required parameter of `create` command, with the content of the file to be created." }),
			),
			insert_line: Type.Optional(
				Type.Number({
					description:
						"Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
				}),
			),
			new_str: Type.Optional(
				Type.String({
					description:
						"Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
				}),
			),
			old_str: Type.Optional(
				Type.String({
					description: "Required parameter of `str_replace` command containing the string in `path` to replace.",
				}),
			),
			view_range: Type.Optional(
				Type.Array(Type.Number(), {
					description:
						"Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
				}),
			),
		}),
		async execute(_toolCallId, params: Record<string, unknown>, _signal, _onUpdate, _ctx: ExtensionContext) {
			const command = params.command as EditorCommand;
			const path = params.path as string;
			let text: string;
			switch (command) {
				case "view":
					text = viewPath(path, params.view_range as number[] | undefined, maxOutputChars);
					break;
				case "create":
					text = createFile(path, params.file_text as string | undefined);
					break;
				case "str_replace":
					text = strReplace(path, params.old_str as string | undefined, params.new_str as string | undefined);
					break;
				case "insert":
					text = insertLine(path, params.insert_line as number | undefined, params.new_str as string | undefined);
					break;
				default:
					throw new Error(`Unknown command: ${String(command)}`);
			}
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}
