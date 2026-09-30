// classifier-key.ts — 分类模型 API key 的读取与保存（auth.json 的 siliconflow-cn 条目）
//
// key 放 pi 的凭据文件 auth.json 里的 `siliconflow-cn.key`，与其它 provider 凭据同处一地。
// 本模块只碰这一个键：读时宽容（兼容 providers 嵌套形态），写时 read-modify-write 保结构，
// 落盘前备份，**任何路径都不打印 key 值**。
//
// 为什么不让 classifier-client 自己读文件：client 是纯 HTTP 层，凭据来源是策略问题。
// 这里单独一层，方便以后换成 pi 的 getApiKeyForProvider() 或别的 keyring。

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** auth.json 里承载 SiliconFlow key 的 provider 名（与提督现有凭据约定一致） */
export const AUTH_PROVIDER = "siliconflow-cn";
/** 环境变量覆盖（临时用；优先级高于 auth.json） */
export const ENV_KEYS = ["TYPESAFE_API_KEY", "SILICONFLOW_API_KEY"];

export function authFilePath(): string {
	return join(getAgentDir(), "auth.json");
}

interface AuthDoc {
	[key: string]: unknown;
}

function parseAuth(text: string): AuthDoc | undefined {
	try {
		const doc = JSON.parse(text);
		return typeof doc === "object" && doc !== null ? (doc as AuthDoc) : undefined;
	} catch {
		return undefined;
	}
}

/** 从一个 provider 条目里取 key（容忍 key / apiKey / api_key 三种写法） */
function keyOf(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry.trim() || undefined;
	if (typeof entry !== "object" || entry === null) return undefined;
	const obj = entry as Record<string, unknown>;
	for (const field of ["key", "apiKey", "api_key"]) {
		const value = obj[field];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/**
 * 读 auth.json 里的 siliconflow-cn key。
 * 宽容形态：顶层 `{ "siliconflow-cn": { key } }`，或 `{ providers: { ... } }` 嵌套。
 */
export function readKeyFromAuth(path: string = authFilePath()): string | undefined {
	if (!existsSync(path)) return undefined;
	const doc = parseAuth(readFileSync(path, "utf8"));
	if (!doc) return undefined;
	const direct = keyOf(doc[AUTH_PROVIDER]);
	if (direct) return direct;
	const providers = doc.providers;
	if (providers && typeof providers === "object") {
		const nested = keyOf((providers as Record<string, unknown>)[AUTH_PROVIDER]);
		if (nested) return nested;
	}
	return undefined;
}

/** 环境变量 → auth.json；都没有则 undefined */
export function resolveReviewApiKey(
	env: NodeJS.ProcessEnv = process.env,
	authPath: string = authFilePath(),
): string | undefined {
	for (const name of ENV_KEYS) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return readKeyFromAuth(authPath);
}

export type SaveKeyResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * 保存 key 到 auth.json 的 siliconflow-cn 条目（read-modify-write）。
 *
 * 安全要点：
 *   - 只动 `siliconflow-cn` 这一个键，其它 provider 凭据原样保留
 *   - 解析不了现有 auth.json 时**不覆盖**（宁可报错，也不能把用户的凭据炸掉）
 *   - 落盘前拷一份 .bak
 */
export function saveKeyToAuth(key: string, path: string = authFilePath()): SaveKeyResult {
	const trimmed = key.trim();
	if (!trimmed) return { ok: false, error: "key 为空" };

	let doc: AuthDoc = {};
	if (existsSync(path)) {
		const text = readFileSync(path, "utf8");
		const parsed = parseAuth(text);
		if (!parsed) return { ok: false, error: `现有 ${path} 不是合法 JSON，拒绝覆盖（请先手工修好或移走它）` };
		doc = parsed;
	}

	// 已有 providers 嵌套形态时跟着它走，不要凭空多造一层
	const container =
		doc.providers && typeof doc.providers === "object" && !Array.isArray(doc.providers)
			? (doc.providers as Record<string, unknown>)
			: doc;
	const existing = container[AUTH_PROVIDER];
	const entry = typeof existing === "object" && existing !== null ? { ...(existing as Record<string, unknown>) } : {};
	entry.key = trimmed;
	container[AUTH_PROVIDER] = entry;

	try {
		if (existsSync(path)) copyFileSync(path, `${path}.bak`);
		writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		return { ok: true, path };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
