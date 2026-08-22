// catalog.ts — OpenCode Zen 免费模型清单的持久化
//
// 把探活结果存成本地 JSON（extensions/opencode-free/models.json）。
// 这样：
//   - 探活结果不用每次会话重启都重跑（几十次请求费时且易触发限流）
//   - llm-review / review-pool 可随时读这份清单，不依赖扩展活的注册
//   - 手动 /opencode:sync 刷新；启动时若有陈旧清单可复用，避免冷启动打爆 Zen
//
// 清单是"最近一次探活的快照"，不是保证。免费档会随促销/限流/地理墙波动，
// 因此每次 sync 都会重探并覆盖。旧清单里已下架的模型会被移除。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FreeModelProbe } from "./zen-client.ts";

export interface FreeModelCatalog {
	/** 最近一次同步时间（epoch ms） */
	updatedAt: number;
	/** 探活可用的模型 */
	models: FreeModelProbe[];
}

export const CATALOG_PATH = join(
	getAgentDir(),
	"extensions",
	"opencode-free",
	"models.json",
);

/** 读清单（缺失/解析失败 → null，表示尚未同步过） */
export function loadCatalog(): FreeModelCatalog | null {
	try {
		const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as FreeModelCatalog;
		if (!Array.isArray(raw.models)) return null;
		return raw;
	} catch {
		return null;
	}
}

/** 读清单中可用的模型 id 列表（无清单 → 空） */
export function loadUsableModelIds(): string[] {
	const cat = loadCatalog();
	if (!cat) return [];
	return cat.models.filter((m) => m.ok).map((m) => m.id);
}

/** 写清单（覆盖） */
export function saveCatalog(probes: FreeModelProbe[]): void {
	mkdirSync(dirname(CATALOG_PATH), { recursive: true });
	const cat: FreeModelCatalog = {
		updatedAt: Date.now(),
		models: probes,
	};
	writeFileSync(CATALOG_PATH, JSON.stringify(cat, null, 2), "utf8");
}
