/**
 * 平台检测与价格提取模块
 *
 * 自动检测用户添加的第三方 API 提供商后端类型，
 * 如果是已知的网关平台（New API / One API 等），
 * 直接从其自身接口拉取真实模型名和价格。
 *
 * 设计原则：
 *   1. 所有 URL 从用户提供的 baseUrl 推导，不硬编码外部地址
 *   2. 匹配逻辑基于 API 响应结构指纹，不依赖域名白名单
 *   3. 检测不到也不报错，降级为标准 OpenAI 模型列表
 */

// ─── 类型 ───────────────────────────────────────────

/** 模型价格（从平台接口拉取的真实定价） */
export interface RealModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** 从平台接口提取的模型信息 */
export interface DetectedModel {
  id: string;
  displayName: string;
  price: RealModelPrice | null;
}

/** 检测到的平台类型 */
export type PlatformType =
  | "new-api"
  | "one-api"
  | "openai-compatible"
  | "unknown";

/** 平台检测结果 */
export interface DetectResult {
  type: PlatformType;
  /** 平台的管理 API 根路径（可能是 baseUrl 的上级） */
  adminRoot: string;
  /** 从平台接口提取的模型列表（含价格） */
  models: DetectedModel[] | null;
}

// ─── 指纹特征 ───────────────────────────────────────

/**
 * New API 的 /api/status 返回体中独有的特征字段
 * 这些字段组合出现可唯一标识 New API
 */
const NEW_API_STATUS_SIGNATURE = [
  "version",
  "system_name",
  "logo",
  "footer_html",
  "quota_per_unit",
  "email_verification",
  "github_oauth",
];

/**
 * One API 跟 New API 状态接口高度相似但有细微差别
 * 暂用相同指纹，后续可通过 version 字符串内容区分
 */
const ONE_API_STATUS_SIGNATURE = [
  "version",
  "system_name",
  "logo",
  "footer_html",
  "quota_per_unit",
];

// ─── URL 推导 ───────────────────────────────────────

/**
 * 从用户提供的 baseUrl 推导可能的「管理 API 根路径」
 *
 * 例如：
 *   https://tokenflux.dev/v1        → https://tokenflux.dev
 *   https://api.example.com/v1/chat → https://api.example.com
 *   https://proxy.foo.com           → https://proxy.foo.com
 */
function deriveAdminRoot(baseUrl: string): string[] {
  const candidates: string[] = [];
  try {
    const url = new URL(baseUrl);
    const origin = url.origin;

    // 原始值
    candidates.push(baseUrl.replace(/\/+$/, ""));

    // 去掉 path 中的 /v1, /v2, /api 后缀
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    while (parts.length > 0 && /^(v\d+|api|openapi)$/i.test(parts[parts.length - 1])) {
      parts.pop();
    }
    candidates.push(parts.length === 0 ? origin : `${origin}/${parts.join("/")}`);

    // 直接用 origin
    if (!candidates.includes(origin)) {
      candidates.push(origin);
    }
  } catch {
    candidates.push(baseUrl.replace(/\/+$/, ""));
  }

  return [...new Set(candidates)];
}

// ─── 平台检测 ───────────────────────────────────────

/**
 * 检测平台类型
 * 按 adminRoot 候选列表依次探测
 */
export async function detectPlatform(
  baseUrl: string,
  apiKey: string,
): Promise<DetectResult> {
  const adminRoots = deriveAdminRoot(baseUrl);

  // 策略 1：检测 New API / One API
  for (const root of adminRoots) {
    const result = await probeNewApi(root, apiKey);
    if (result) return result;
  }

  // 策略 2：标准 OpenAI 兼容
  const fallbackModels = await probeOpenAICompatible(baseUrl, apiKey);
  if (fallbackModels) {
    return {
      type: "openai-compatible",
      adminRoot: baseUrl,
      models: fallbackModels,
    };
  }

  return { type: "unknown", adminRoot: baseUrl, models: null };
}

/**
 * 探测是否为 New API / One API
 */
async function probeNewApi(
  adminRoot: string,
  apiKey: string,
): Promise<DetectResult | null> {
  // Step 1：访问 /api/status 检查指纹
  const statusUrl = `${adminRoot}/api/status`;
  try {
    const res = await fetch(statusUrl, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const body = await res.json() as Record<string, unknown>;
    if (!body || typeof body !== "object") return null;

    // 检查特征字段
    const fields = Object.keys(body);
    const newApiHits = NEW_API_STATUS_SIGNATURE.filter(f => fields.includes(f));
    const oneApiHits = ONE_API_STATUS_SIGNATURE.filter(f => fields.includes(f));

    const type = newApiHits.length >= 5 ? "new-api"
      : oneApiHits.length >= 4 ? "one-api"
      : null;
    if (!type) return null;
  } catch {
    return null;
  }

  // Step 2：拉取模型和价格
  const models = await fetchNewApiModels(adminRoot, apiKey);

  return { type: "new-api" as PlatformType, adminRoot, models };
}

/**
 * 从 New API 的 /api/models 拉取模型及价格
 */
async function fetchNewApiModels(
  adminRoot: string,
  apiKey: string,
): Promise<DetectedModel[] | null> {
  const modelsUrl = `${adminRoot}/api/models`;

  try {
    const res = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const body = await res.json() as { success?: boolean; data?: unknown };
    if (!body.success || !body.data || typeof body.data !== "object") return null;

    // data 结构: { channelId: Model[] }
    // 展开所有 channel 下的模型，按模型 ID 去重
    const data = body.data as Record<string, unknown>;
    const seen = new Set<string>();
    const models: DetectedModel[] = [];

    for (const channelModels of Object.values(data)) {
      if (!Array.isArray(channelModels)) continue;
      for (const raw of channelModels) {
        if (!raw || typeof raw !== "object") continue;
        const m = raw as Record<string, unknown>;
        const id = String(m.id ?? m.Id ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const price = extractPrice(m);
        models.push({
          id,
          displayName: String(m.display_name ?? m.name ?? id),
          price,
        });
      }
    }

    return models.length > 0 ? models : null;
  } catch {
    // /api/models 不可用（可能没权限，或不是标准 New API 部署）
    return null;
  }
}

/**
 * 从模型对象中提取定价
 * New API 的模型可选包含 input_price / output_price 等字段
 */
function extractPrice(raw: Record<string, unknown>): RealModelPrice | null {
  const input = asNumber(raw.input_price ?? raw.price);
  const output = asNumber(raw.output_price);

  if (input === undefined && output === undefined) return null;

  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheWrite: asNumber(raw.cache_write_price) ?? 0,
    cacheRead: asNumber(raw.cache_read_price) ?? 0,
  };
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

/**
 * 标准 OpenAI 兼容：/v1/models
 */
async function probeOpenAICompatible(
  baseUrl: string,
  apiKey: string,
): Promise<DetectedModel[] | null> {
  const url = `${baseUrl}/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const body = await res.json() as { data?: Array<{ id: string }> };
    if (!Array.isArray(body.data)) return null;

    return body.data.map(m => ({
      id: m.id,
      displayName: m.id,
      price: null,
    }));
  } catch {
    return null;
  }
}

// ─── 公共 API ───────────────────────────────────────

/**
 * 一步完成检测 + 提取模型
 * 对上游调用方屏蔽内部实现细节
 */
export async function detectAndExtractModels(
  baseUrl: string,
  apiKey: string,
): Promise<DetectResult> {
  return detectPlatform(baseUrl, apiKey);
}
