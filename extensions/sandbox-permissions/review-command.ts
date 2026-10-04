// review-command.ts — /sandbox:review：分类审核后端的维度阈值面板
//
// 面板管三件事：每个维度是否启用、above/below 两条阈值、动作（review / ignore）。
// **没有 block 这个选项**——分类器是试验品，不允许它直接拒绝任何请求。
//
// 阈值写在独立文件 review-dimensions.toml（本文件整文件重写它）。为什么不写 extensions.toml：
// 那是手写的核心配置，程序化整段重写容易把别的段弄坏；阈值是高频调整项，单独放更稳。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { DIMENSIONS, type DimensionConfig } from "./review-dimensions.ts";
import { DIMENSIONS_TOML_PATH, loadClassifierConfig } from "./review-classifier.ts";
import { readKeyFromAuth, saveKeyToAuth } from "./classifier-key.ts";

/** 阈值调整步长 */
export const STEP = 0.05;

const HEADER = `# 指令审核维度阈值（分类模型后端）
#
# 由 /sandbox:review 面板维护（整文件重写，手改请保持本格式）。
# 端点与模型在 extensions.toml 的 [sandbox-review-classifier]；本文件只管阈值。
#
#   above  = 风险值高于它 → 提示用户过目
#            （choice 取高风险档概率之和；score 按档位线性归一化；noul 取「是」的概率）
#   below  = 置信度低于它 → 提示用户过目（模型没把握，宁可信其有）
#            noul 没有置信度，该字段对 scripted_edit 无效
#   action = review（提示）| ignore（不看这一维）
#            —— 没有 block：分类器是试验品，不允许它直接拒绝任何请求
`;

/** 阈值夹到 [0.05, 0.99] 并保留两位（0 会让阈值永远触发，没有意义） */
export function adjustThreshold(value: number, delta: number): number {
	const next = Math.round((value + delta) * 100) / 100;
	return Math.max(0.05, Math.min(0.99, next));
}

/** 动作轮转：只有 review 与 ignore */
export function cycleAction(action: DimensionConfig["action"]): DimensionConfig["action"] {
	return action === "review" ? "ignore" : "review";
}

/** 维度配置 → TOML 文本（整文件内容；写回与测试共用） */
export function formatDimensionsToml(dims: DimensionConfig[]): string {
	const blocks = dims.map((d) => {
		const lines = [`[[dimension]]`, `id = "${d.id}"`, `enabled = ${d.enabled}`, `above = ${d.above.toFixed(2)}`];
		if (d.below !== null) lines.push(`below = ${d.below.toFixed(2)}`);
		lines.push(`action = "${d.action}"`);
		return lines.join("\n");
	});
	return `${HEADER}\n${blocks.join("\n\n")}\n`;
}

export function writeDimensions(dims: DimensionConfig[]): void {
	writeFileSync(DIMENSIONS_TOML_PATH, formatDimensionsToml(dims), "utf8");
}

/** 面板行文本 */
export function rowText(config: DimensionConfig, spec: { label: string; type: string; supportsBelow: boolean }, width: number): string {
	const box = config.enabled ? "[x]" : "[ ]";
	const below = spec.supportsBelow ? (config.below ?? 0).toFixed(2) : "  - ";
	const action = config.action === "review" ? "提示" : "忽略";
	return `${box} ${spec.label.padEnd(6, "　")} ${spec.type.padEnd(6)} above ${config.above.toFixed(2)} · below ${below} · ${action}`;
}

/** 纯文本形态（非 TUI 环境） */
export function dimensionsAsText(dims: DimensionConfig[]): string {
	return dims
		.map((d) => {
			const spec = DIMENSIONS.find((s) => s.id === d.id);
			const below = spec?.supportsBelow ? (d.below ?? 0).toFixed(2) : "-";
			return `${d.enabled ? "开" : "关"} ${d.id} above=${d.above.toFixed(2)} below=${below} ${d.action}`;
		})
		.join("\n");
}

/**
 * /sandbox:review key —— 用 pi 的输入框录入 key，写进 auth.json 的 siliconflow-cn。
 * 全程不打印 key 值：只报“已保存（长度 N）”。
 */
async function promptForKey(ctx: ExtensionCommandContext): Promise<void> {
	const current = readKeyFromAuth();
	const hint = current
		? `已配置（长度 ${current.length}）。粘贴新 key 覆盖，直接回车取消`
		: "粘贴 SiliconFlow 的 API key（写入 auth.json 的 siliconflow-cn.key）";
	const input = await ctx.ui.input("SiliconFlow API key", hint);
	if (input === undefined || input.trim() === "") {
		ctx.ui.notify("未改动", "info");
		return;
	}
	const result = saveKeyToAuth(input);
	if (result.ok) {
		ctx.ui.notify(`已保存到 ${result.path}（长度 ${input.trim().length}）`, "info");
	} else {
		ctx.ui.notify(`保存失败：${result.error}`, "error");
	}
}

export async function reviewCommandHandler(args: string, ctx: ExtensionCommandContext): Promise<void> {
	// 子命令：/sandbox:review key —— 用 TUI 录入 SiliconFlow API key（写进 auth.json）
	if (args.trim().toLowerCase() === "key") {
		await promptForKey(ctx);
		return;
	}
	if (args.trim() !== "") {
		ctx.ui.notify(`未知参数“${args.trim()}”：用法 /sandbox:review [key]`, "warning");
		return;
	}

	const cfg = loadClassifierConfig();
	let dims = cfg.dimensions.map((d) => ({ ...d }));
	let dirty = false;

	if (ctx.mode !== "tui") {
		const hasKey = readKeyFromAuth() !== undefined;
		ctx.ui.notify(
			`审核后端：${cfg.model}（分类模型）· key ${hasKey ? "已配置" : "未配置（/sandbox:review key）"}\n${dimensionsAsText(dims)}`,
			"info",
		);
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, finish) => {
		let selected = 0;
		let closed = false;

		const close = (): void => {
			if (closed) return;
			closed = true;
			finish(undefined);
		};

		const spec = (id: string) => DIMENSIONS.find((s) => s.id === id);

		const render = (width: number): string[] => {
			const lines: string[] = [];
			lines.push(
				theme.fg("accent", theme.bold("指令审核维度（分类模型）"))
					+ theme.fg("dim", `  后端 ${cfg.model} · key ${readKeyFromAuth() ? "已配置" : "未配置（/sandbox:review key）"}`),
			);
			lines.push(theme.fg("dim", "above = 风险高于它提示 · below = 置信度低于它提示（- 表示该维度没有置信度）"));
			// 场景不影响本面板的配置值：PTC 场景只是不问 scripted_edit（审批窗里灰显）
			lines.push(theme.fg("dim", "PTC（run_code）脚本审核不问 scripted_edit，该行在审批窗中灰显"));
			lines.push("");
			dims.forEach((d, i) => {
				const s = spec(d.id);
				const line = rowText(d, { label: s?.label ?? d.id, type: s?.type ?? "?", supportsBelow: s?.supportsBelow ?? false }, width);
				const marker = i === selected ? theme.fg("accent", "❯ ") : "  ";
				const body = d.enabled ? line : theme.fg("dim", line);
				lines.push(i === selected ? theme.bold(marker + body) : marker + body);
			});
			lines.push("");
			const cur = dims[selected];
			if (cur) {
				const s = spec(cur.id);
				lines.push(theme.fg("muted", `${cur.id}：${s?.instructions ?? ""}`));
			}
			if (dirty) lines.push(theme.fg("warning", "有未保存的改动 — 按 w 保存"));
			return lines.map((line) => truncateToWidth(line, width));
		};

		const handle = (data: string): void => {
			if (matchesKey(data, Key.escape) || data === "q") {
				close();
				return;
			}
			if (matchesKey(data, Key.up) || data === "k") {
				selected = Math.max(0, selected - 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				selected = Math.min(dims.length - 1, selected + 1);
				tui.requestRender();
				return;
			}
			const cur = dims[selected];
			if (!cur) return;
			const supportsBelow = spec(cur.id)?.supportsBelow ?? false;

			if (data === " ") {
				cur.enabled = !cur.enabled;
				dirty = true;
			} else if (data === "a") {
				cur.action = cycleAction(cur.action);
				dirty = true;
			} else if (data === "+" || data === "=") {
				cur.above = adjustThreshold(cur.above, STEP);
				dirty = true;
			} else if (data === "-") {
				cur.above = adjustThreshold(cur.above, -STEP);
				dirty = true;
			} else if (data === "]" && supportsBelow) {
				cur.below = adjustThreshold(cur.below ?? 0.5, STEP);
				dirty = true;
			} else if (data === "[" && supportsBelow) {
				cur.below = adjustThreshold(cur.below ?? 0.5, -STEP);
				dirty = true;
			} else if (data === "0") {
				cur.above = 0.5;
				if (supportsBelow) cur.below = 0.5;
				dirty = true;
			} else if (data === "w") {
				try {
					writeDimensions(dims);
					dirty = false;
					ctx.ui.notify(`已保存到 ${DIMENSIONS_TOML_PATH.replace(/^.*sandbox-permissions\//, "extensions/sandbox-permissions/")}`, "info");
				} catch (err) {
					ctx.ui.notify(`保存失败：${err instanceof Error ? err.message : String(err)}`, "error");
				}
				tui.requestRender();
				return;
			}
			tui.requestRender();
		};

		return {
			render(width: number): string[] {
				const container = new Container();
				container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
				for (const line of render(width - 2)) container.addChild(new Text(line, 1, 0));
				container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
				container.addChild(
					new Text(
						theme.fg("dim", "j/k 移动 · 空格 启停 · a 切动作 · +/- 调 above · [/] 调 below · 0 重置 · w 保存 · Esc 退出"),
						1,
						0,
					),
				);
				return container.render(width);
			},
			invalidate(): void {
				/* 无缓存 */
			},
			handleInput(data: string): void {
				handle(data);
			},
		};
	});
}
