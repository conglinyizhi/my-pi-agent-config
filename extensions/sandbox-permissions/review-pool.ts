// review-pool.ts — 审核模型池管理指令
//
// /provider:fast-put — 从全局模型列表（modelRegistry.getAll()）筛选一个加入审核池，
//                      无需手抄供应商名/模型名；添加后可顺带测试一次审核链路。
// /provider:fast-pop — 从池子里移除一个模型。
//
// 池子独立存放于 review-pool.toml（个人依赖：供应商配置/API key 不入库，已 gitignore）。
// 整个文件就是池子，写回直接整文件重写，不碰 extensions.toml。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parse as parseToml } from "smol-toml";
import { createReviewCache, loadLlmReviewConfig, reviewCommand, type ModelRef } from "./llm-review";

const REVIEW_POOL_PATH = join(getAgentDir(), "extensions", "sandbox-permissions", "review-pool.toml");

/** 从 review-pool.toml 读当前审核池（文件缺失/解析失败 → 空） */
function readPool(): ModelRef[] {
	try {
		const doc = parseToml(readFileSync(REVIEW_POOL_PATH, "utf8")) as { models?: unknown };
		if (!Array.isArray(doc.models)) return [];
		return doc.models
			.filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
			.map((m) => ({
				provider: String(m.provider ?? ""),
				model: String(m.model ?? ""),
			}))
			.filter((m) => m.provider && m.model);
	} catch {
		return [];
	}
}

/** 生成 TOML models 数组块文本 */
function formatModelsBlock(models: ModelRef[]): string {
	if (models.length === 0) return "models = []";
	const lines = models.map((m) => `  { provider = "${m.provider}", model = "${m.model}" },`);
	return `models = [\n${lines.join("\n")}\n]`;
}

/** 整文件写回审核池（review-pool.toml） */
function writePool(models: ModelRef[]): void {
	const block = formatModelsBlock(models);
	const header = "# 审核模型池（个人依赖：供应商配置与 API key 不入库，本文件已 gitignore）\n";
	writeFileSync(REVIEW_POOL_PATH, `${header}${block}\n`, "utf8");
}

/** 上下文/价格展示 */
function fmtCtx(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
	return n > 0 ? String(n) : "?";
}

/** 用指定模型跑一次真实审核，验证链路（命令无害，仅探测模型可用性） */
async function testModel(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	ref: ModelRef,
): Promise<{ verdict: string; reason: string }> {
	const cfg = { ...loadLlmReviewConfig(), models: [ref] };
	const result = await reviewCommand(pi, ctx, "echo review-pool-link-test", [], ctx.signal, createReviewCache(), cfg);
	return { verdict: result.verdict, reason: result.reason };
}

/** /provider:fast-put —— 筛选模型加入审核池 */
export async function poolAddHandler(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const pool = readPool();
	const poolIds = new Set(pool.map((m) => `${m.provider}:${m.model}`));

	// 枚举全局模型列表（modelRegistry.getAll：全部已注册模型，含自定义供应商与内置）
	const registry = ctx.modelRegistry as unknown as { getAll(): readonly { id: string; provider: string; name?: string; contextWindow?: number; cost?: { input: number; output: number } }[] };
	const all = typeof registry.getAll === "function" ? registry.getAll() : [];
	const candidates = all.filter(
		(m) =>
			m &&
			typeof m.id === "string" &&
			m.id !== "auto-detect" && // 跳过占位模型
			!poolIds.has(`${m.provider}:${m.id}`),
	);

	if (candidates.length === 0) {
		ctx.ui.notify("没有可添加的模型（池子里已包含所有可用模型）", "info");
		return;
	}

	// 关键词过滤：args 参数或交互输入
	let keyword = args.trim();
	if (!keyword) {
		keyword = (await ctx.ui.input("输入关键词过滤模型（支持 provider:model 或模型名；留空列出全部）", ""))?.trim() ?? "";
	}
	const kw = keyword.toLowerCase();
	const matched = kw
		? candidates.filter(
				(m) =>
					`${m.provider}:${m.id}`.toLowerCase().includes(kw) ||
					m.id.toLowerCase().includes(kw) ||
					(m.name ?? "").toLowerCase().includes(kw),
			)
		: candidates;

	if (matched.length === 0) {
		ctx.ui.notify(`没有匹配「${keyword}」的模型`, "warning");
		return;
	}

	// 展示候选（最多 30 个），单选
	const limited = matched.slice(0, 30);
	const options = limited.map((m) => {
		const c = m.cost;
		const price = c && (c.input > 0 || c.output > 0) ? `¥${c.input.toFixed(2)}/${c.output.toFixed(2)}` : "价格未知";
		return `${m.provider}/${m.id}（${fmtCtx(m.contextWindow ?? 0)} | ${price}）`;
	});
	if (matched.length > limited.length) options.push(`… 还有 ${matched.length - limited.length} 个匹配，输入更精确的关键词再筛`);
	options.push("❌ 取消");

	const choice = await ctx.ui.select(`匹配 ${matched.length} 个模型，选一个加入审核池：`, options);
	if (!choice || choice.startsWith("❌") || choice.startsWith("…")) {
		ctx.ui.notify("已取消", "info");
		return;
	}
	const idx = options.indexOf(choice);
	const chosen = limited[idx];
	if (!chosen) {
		ctx.ui.notify("选择无效", "error");
		return;
	}

	const ref: ModelRef = { provider: chosen.provider, model: chosen.id };
	try {
		writePool([...pool, ref]);
	} catch (err) {
		ctx.ui.notify(`写入失败: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	ctx.ui.notify(`已加入审核池：${ref.provider}/${ref.model}（当前 ${pool.length + 1} 个）`, "info");

	// 顺带测试链路（可选）
	const testChoice = await ctx.ui.select("是否用该模型测试一次审核链路？", ["✅ 测试", "⏭ 跳过"]);
	if (!testChoice?.startsWith("✅")) return;
	const r = await testModel(ctx, pi, ref);
	if (r.verdict === "error") {
		ctx.ui.notify(`❌ 链路测试失败：${r.reason}`, "error");
	} else {
		ctx.ui.notify(`✅ 链路测试通过（${r.verdict}）：${r.reason}`, "info");
	}
}

/** /provider:fast-pop —— 从审核池移除模型 */
export async function poolRemoveHandler(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const pool = readPool();
	if (pool.length === 0) {
		ctx.ui.notify("审核池为空，无需移除", "info");
		return;
	}

	// args 指定（provider/model 或模型名模糊）优先，否则 TUI 选择
	let target: ModelRef | undefined;
	if (args.trim()) {
		const kw = args.trim().toLowerCase();
		target = pool.find(
			(m) =>
				`${m.provider}:${m.model}`.toLowerCase() === kw ||
				`${m.provider}/${m.model}`.toLowerCase() === kw ||
				m.model.toLowerCase().includes(kw),
		);
		if (!target) {
			ctx.ui.notify(`池子里没有匹配「${args.trim()}」的模型`, "warning");
			return;
		}
	} else {
		const options = pool.map((m) => `${m.provider}/${m.model}`);
		options.push("❌ 取消");
		const choice = await ctx.ui.select(`当前审核池（${pool.length} 个），选一个移除：`, options);
		if (!choice || choice.startsWith("❌")) {
			ctx.ui.notify("已取消", "info");
			return;
		}
		const idx = options.indexOf(choice);
		target = pool[idx];
	}

	const newPool = pool.filter((m) => !(m.provider === target.provider && m.model === target.model));
	try {
		writePool(newPool);
	} catch (err) {
		ctx.ui.notify(`写入失败: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	ctx.ui.notify(
		`已从审核池移除：${target.provider}/${target.model}${newPool.length === 0 ? "（池子已空，审核将回退当前会话模型）" : `（剩余 ${newPool.length} 个）`}`,
		"info",
	);
}
