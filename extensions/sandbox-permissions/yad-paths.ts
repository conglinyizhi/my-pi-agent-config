// yad-paths.ts — yad 图形界面（三类路径配置的 GUI 形态）
//
// 形态参考 hub/allow_dialog.go 的 runAllowDialog：`yad --title=… --text=… --form --field=…:CE
// --button=关闭:1 --button=授权:0`，靠**退出码**区分按钮，stdout 读结果（表单字段用 `|` 分隔，
// 列表行也用 `|` 分隔列）。这里只做四件事：找 yad、判有没有图形、拉进程、把三种对话框
// （列表 / 表单 / 文本确认）包成带结果的函数。
//
// 约定：
//   - runner 可注入（测试一律用假 runner）。真实 runner 在 node --test 环境里直接返回
//     不可用：yad 是阻塞式、等人点的窗口，测试里绝不该被拉起来
//   - 退出码 0 = 正常提交（stdout 有数据）；其它退出码 = 用户取消 / 关窗
//   - 启动失败（ENOENT 等）或 stderr 报「打不开 display」= unavailable，调用方回退 TUI
//   - 「点一下能用」需要人对着窗口验一次，本文件的自测只覆盖到假 runner 那一层

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/** yad 进程结果 */
export interface YadResult {
	/** 退出码；进程没起来时为 null */
	code: number | null;
	stdout: string;
	stderr: string;
	/** spawn 层面的失败（ENOENT / EACCES 等） */
	error?: string;
}

/** 可注入的 runner：真实实现是 spawn，测试用假的 */
export type YadRunner = (
	bin: string,
	args: string[],
	opts: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<YadResult>;

/** 在 PATH 里找 yad（不用 spawn，避免为了「找」拉起一个进程） */
export function findYadBinary(env: NodeJS.ProcessEnv = process.env): string | null {
	for (const dir of (env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, "yad");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// 继续找下一个
		}
	}
	return null;
}

/** 图形环境判定（默认看 DISPLAY / WAYLAND_DISPLAY） */
export function hasDisplay(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** 建 yad 会话要的外部依赖（各命令共用；测试一律注入假 runner） */
export interface YadSessionDeps {
	runner?: YadRunner;
	findYad?: (env: NodeJS.ProcessEnv) => string | null;
	hasDisplay?: (env: NodeJS.ProcessEnv) => boolean;
	env?: NodeJS.ProcessEnv;
}

/**
 * 图形通道是否可用：有界面 + 找到 yad + 有 DISPLAY 才开窗。
 * 三条任一不满足就返回 null，由调用方回退 TUI（/sandbox:paths 与 /sandbox:network 共用）。
 */
export function resolveYadSession(
	target: { hasUI: boolean; signal?: AbortSignal },
	deps: YadSessionDeps = {},
): YadSession | null {
	if (!target.hasUI) return null;
	const env = deps.env ?? process.env;
	const bin = (deps.findYad ?? findYadBinary)(env);
	if (!bin) return null;
	if (!(deps.hasDisplay ?? hasDisplay)(env)) return null;
	return { bin, env, runner: deps.runner ?? realYadRunner, signal: target.signal };
}

/** stderr 里出现这些 = 不是用户取消，而是窗口根本起不来（无 display / 无 GTK 等） */
const DISPLAY_ERROR_RE = /cannot open display|unable to open display|can't open display|Failed to open display|Gtk-?WARNING/i;

/**
 * 真实 runner。测试注入假 runner；万一漏了注入，NODE_TEST_CONTEXT（node --test 的内部标记）
 * 会让它直接判不可用，而不是把测试挂在一个等人点的窗口上。
 */
export const realYadRunner: YadRunner = (bin, args, opts) => {
	if (process.env.NODE_TEST_CONTEXT) {
		return Promise.resolve({ code: null, stdout: "", stderr: "", error: "test-context：测试里不拉真实 yad" });
	}
	return new Promise<YadResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const done = (r: YadResult) => {
			if (settled) return;
			settled = true;
			resolve(r);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(bin, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: opts.env,
				signal: opts.signal,
			});
		} catch (err) {
			done({ code: null, stdout, stderr, error: err instanceof Error ? err.message : String(err) });
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err: Error) => {
			done({ code: null, stdout, stderr, error: err.message });
		});
		child.on("close", (code: number | null) => {
			done({ code, stdout, stderr });
		});
	});
};

// ═══════════════════════════════════════════════════
// 对话框（三种形态）
// ═══════════════════════════════════════════════════

export type YadOutcome =
	| { kind: "ok"; stdout: string }
	| { kind: "cancel" }
	| { kind: "unavailable"; detail: string };

export interface YadSession {
	bin: string;
	env: NodeJS.ProcessEnv;
	runner: YadRunner;
	signal?: AbortSignal;
}

/** 跑一次 yad 并把退出码翻成结果 */
export async function yadRun(session: YadSession, args: string[]): Promise<YadOutcome> {
	let result: YadResult;
	try {
		result = await session.runner(session.bin, args, { env: session.env, signal: session.signal });
	} catch (err) {
		return { kind: "unavailable", detail: err instanceof Error ? err.message : String(err) };
	}
	if (result.error) {
		// 被中止不算「窗口拉不起来」：中止了就别再转去 TUI 追问
		if (session.signal?.aborted) return { kind: "cancel" };
		return { kind: "unavailable", detail: result.error };
	}
	if (result.code === 0) return { kind: "ok", stdout: result.stdout };
	if (result.code === null) return { kind: "cancel" };
	const stderr = result.stderr ?? "";
	if (DISPLAY_ERROR_RE.test(stderr)) {
		return { kind: "unavailable", detail: stderr.trim().split("\n")[0] || `退出码 ${result.code}` };
	}
	return { kind: "cancel" };
}

/** 拆 yad 的 `|` 分隔输出（表单尾部带一个空字段，列表则没有） */
export function splitFields(stdout: string): string[] {
	const line = stdout.replace(/\r?\n+$/, "");
	if (!line) return [];
	const parts = line.split("|");
	if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
	return parts;
}

/**
 * 窗口尺寸：默认给得大一些（三类路径配置的概览文字很长，不给定尺寸会挤成一条）。
 * 内容少的对话框自己传小的 —— 三行字的单选窗占 920x640 是浪费屏幕（人眼就看着大窗里那几行）。
 */
const DEFAULT_WINDOW_WIDTH = 920;
const DEFAULT_WINDOW_HEIGHT = 640;

function windowArgs(width?: number, height?: number): string[] {
	return [`--width=${width ?? DEFAULT_WINDOW_WIDTH}`, `--height=${height ?? DEFAULT_WINDOW_HEIGHT}`, "--center"];
}

/** 窗口尺寸覆盖（不给就用默认那对） */
export interface YadWindowSize {
	width?: number;
	height?: number;
}

export interface YadListSpec extends YadWindowSize {
	title: string;
	text: string;
	/** 表头（也是列的声明） */
	headers: string[];
	/** 行数据（每行长度与 headers 对齐） */
	rows: string[][];
	okLabel: string;
	cancelLabel?: string;
}

/** 单选列表：返回选中行的**序号**（数据从调用方自己的 rows 里取，不解析 yad 的列） */
export async function yadPickRow(
	session: YadSession,
	spec: YadListSpec,
): Promise<{ kind: "ok"; index: number } | { kind: "cancel" } | { kind: "unavailable"; detail: string }> {
	const args = [
		`--title=${spec.title}`,
		`--text=${spec.text}`,
		...windowArgs(spec.width, spec.height),
		"--list",
		`--button=${spec.okLabel}:0`,
		`--button=${spec.cancelLabel ?? "取消"}:1`,
		...spec.headers.map((h) => `--column=${h}`),
		...spec.rows.flat(),
	];
	const out = await yadRun(session, args);
	if (out.kind !== "ok") return out;
	const index = matchRowIndex(out.stdout, spec.rows);
	return index >= 0 ? { kind: "ok", index } : { kind: "cancel" };
}

/**
 * 从 yad 的列表输出里认出选中的是第几行。
 *
 * 不解析列内容、只用来认行：行内的列分隔符按 `|` 走（表单与列表的默认值），
 * 认不出来时再用首列值做一次包含匹配兜底。真正取数据一律回到传进去的 rows，
 * 这样即使 yad 换个分隔符写法，取到的目录也不会串行。
 */
export function matchRowIndex(stdout: string, rows: string[][]): number {
	const line = stdout.replace(/\r?\n+$/, "").trim();
	if (!line) return -1;
	const joined = rows.findIndex((r) => r.join("|") === line);
	if (joined >= 0) return joined;
	const hits: number[] = [];
	rows.forEach((r, i) => {
		const first = r[0];
		if (first && line.includes(first)) hits.push(i);
	});
	return hits.length === 1 ? hits[0] : -1;
}

/** 表单取一个值（目录输入） */
export async function yadInputValue(
	session: YadSession,
	spec: YadWindowSize & { title: string; text: string; label: string; value?: string; okLabel: string },
): Promise<{ kind: "ok"; value: string } | { kind: "cancel" } | { kind: "unavailable"; detail: string }> {
	const args = [
		`--title=${spec.title}`,
		`--text=${spec.text}`,
		...windowArgs(spec.width, spec.height),
		"--form",
		`--field=${spec.label}:CE`,
		spec.value ?? "",
		`--button=${spec.okLabel}:0`,
		"--button=取消:1",
	];
	const out = await yadRun(session, args);
	if (out.kind !== "ok") return out;
	return { kind: "ok", value: splitFields(out.stdout)[0]?.trim() ?? "" };
}

/** 文本对话框：确认（两个按钮）或纯展示（一个按钮） */
export async function yadText(
	session: YadSession,
	spec: YadWindowSize & { title: string; text: string; okLabel: string; cancelLabel?: string },
): Promise<{ kind: "ok" } | { kind: "cancel" } | { kind: "unavailable"; detail: string }> {
	const args = [`--title=${spec.title}`, `--text=${spec.text}`, ...windowArgs(spec.width, spec.height), `--button=${spec.okLabel}:0`];
	if (spec.cancelLabel) args.push(`--button=${spec.cancelLabel}:1`);
	const out = await yadRun(session, args);
	return out.kind === "ok" ? { kind: "ok" } : out;
}
