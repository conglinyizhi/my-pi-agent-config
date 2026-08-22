// opencode-free 扩展 — OpenCode Zen 免费模型，一键刷新进审核模型池
//
// 目标：为沙箱权限门禁的 LLM 预审（sandbox-permissions/llm-review.ts）提供"无 key 的
//      免费模型"来源。这些模型在 OpenCode Zen 中继上是匿名的（空 Authorization 头即可用），
//      不需要 pi 本地 provider 注册、不需要 API key、不碰 providers.toml。
//
// 只提供一个命令：
//   /opencode:reload-free-models — 探活 Zen 免费档，把当前可用的全部免费模型写进审核模型池
//                                  （review-pool.toml），保留池子里其它非免费条目。
//
// 与 sandbox-permissions 的联动：
//   llm-review.ts 在解析 review-pool.toml 时，遇到 provider === "opencode-free" 的条目，
//   不走 modelRegistry.find()/complete()，而是直接调 zen-client.callZenChat()（空 key 裸调）。
//   审核池里免费模型 + 本地付费模型在同一 failover 链，免费优先、付费兜底。

import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { probeFreeCatalog } from "./zen-client.ts";
import { saveCatalog } from "./catalog.ts";

const REVIEW_POOL_PATH = join(getAgentDir(), "extensions", "sandbox-permissions", "review-pool.toml");
/** 免费模型在审核池里的 provider 标识（与 review-pool.ts / llm-review.ts 约定一致） */
const OPencode_FREE_PROVIDER = "opencode-free";

// ── 审核池读写（保留非免费条目，只替换 opencode-free 相关） ──

interface PoolRef {
	provider: string;
	model: string;
}

function readPool(): PoolRef[] {
	try {
		const doc = parseToml(readFileSync(REVIEW_POOL_PATH, "utf8")) as { models?: unknown };
		if (!Array.isArray(doc.models)) return [];
		return doc.models
			.filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
			.map((m) => ({ provider: String(m.provider ?? ""), model: String(m.model ?? "") }))
			.filter((m) => m.provider && m.model);
	} catch {
		return [];
	}
}

function writePool(models: PoolRef[]): void {
	const block =
		models.length === 0
			? "models = []"
			: `models = [\n${models.map((m) => `  { provider = "${m.provider}", model = "${m.model}" },`).join("\n")}\n]`;
	const header = "# 审核模型池（个人依赖：供应商配置与 API key 不入库，本文件已 gitignore）\n";
	writeFileSync(REVIEW_POOL_PATH, `${header}${block}\n`, "utf8");
}

/** 把可用免费模型写进审核池：保留非免费条目，替换旧的 opencode-free 条目为当前可用集 */
function mergeFreeIntoPool(usableIds: string[]): void {
	const pool = readPool();
	// 去掉旧的 opencode-free 条目（可能含已下架/失效的），保留其它 provider
	const kept = pool.filter((m) => m.provider !== OPencode_FREE_PROVIDER);
	// 追加当前可用免费模型（去重）
	const freeRefs = usableIds.map((id) => ({ provider: OPencode_FREE_PROVIDER, model: id }));
	writePool([...kept, ...freeRefs]);
}

/** /opencode:reload-free-models — 探活并一键刷新进审核池 */
async function reloadHandler(ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.notify("⏳ 正在探活 OpenCode Zen 免费档…（可能要几十秒）", "info");
	const probes = await probeFreeCatalog(ctx.signal, { onlyFree: true });
	const usable = probes.filter((p) => p.ok);
	// 清单快照（供 /provider:fast-put 候选 / 未来诊断用）
	saveCatalog(probes);

	if (usable.length === 0) {
		ctx.ui.notify("⚠️ 探活完成，但没有可用免费模型。审核池里的 opencode-free 条目已清空。", "warning");
		mergeFreeIntoPool([]);
		return;
	}

	mergeFreeIntoPool(usable.map((p) => p.id));
	ctx.ui.notify(
		`✅ 已刷新审核池：${usable.length} 个可用免费模型已加入（其余非免费条目保留）。\n可用：${usable.map((p) => p.id).join(", ")}`,
		"info",
	);
}

export default async function (pi: ExtensionAPI): Promise<void> {
	pi.registerCommand("opencode:reload-free-models", {
		description: "探活 OpenCode Zen 免费档并一键刷新进审核模型池（review-pool.toml）",
		handler: (args, ctx) => reloadHandler(ctx),
	});
}
