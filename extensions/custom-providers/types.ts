export type ApiFormat = "openai-new" | "openai-old" | "anthropic" | "auto";

export type KnownApi = "openai-responses" | "openai-completions" | "anthropic-messages";

/** 模型输入模态。toml / TUI 四项独立；注册到 pi SDK 时只保留 text / image。 */
export const INPUT_CAPABILITIES = ["text", "image", "video", "audio"] as const;
export type InputCapability = (typeof INPUT_CAPABILITIES)[number];
export type PiInputCapability = "text" | "image";

export const INPUT_CAPABILITY_LABELS: Record<InputCapability, string> = {
  text: "文本",
  image: "图像",
  video: "视频",
  audio: "声音",
};

export function isInputCapability(value: unknown): value is InputCapability {
  return value === "text" || value === "image" || value === "video" || value === "audio";
}

/** 解析 toml / 外部数据里的 input：去重、丢掉未知值、排成 text → image → video → audio。缺字段返回 undefined。 */
export function parseInputCapabilities(raw: unknown): InputCapability[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<InputCapability>();
  for (const item of raw) {
    if (isInputCapability(item)) seen.add(item);
  }
  if (seen.size === 0) return undefined;
  return INPUT_CAPABILITIES.filter(cap => seen.has(cap));
}

/** 勾选切换一项，结果保持规范顺序。 */
export function toggleInputCapability(
  current: readonly InputCapability[],
  cap: InputCapability,
): InputCapability[] {
  const seen = new Set(current);
  if (seen.has(cap)) seen.delete(cap);
  else seen.add(cap);
  return INPUT_CAPABILITIES.filter(item => seen.has(item));
}

/** pi SDK 只认 text / image；video / audio 留在 toml 里给其它插件读。全被滤掉时回退 text。 */
export function toPiInput(caps: readonly InputCapability[] | undefined): PiInputCapability[] {
  const filtered = (caps ?? []).filter((cap): cap is PiInputCapability => cap === "text" || cap === "image");
  return filtered.length > 0 ? filtered : ["text"];
}

export function formatInputCapabilities(caps: readonly InputCapability[]): string {
  return caps.map(cap => INPUT_CAPABILITY_LABELS[cap]).join(" + ");
}

export function isDefaultInput(caps: readonly InputCapability[] | undefined): boolean {
  return caps === undefined || caps.length === 0 || (caps.length === 1 && caps[0] === "text");
}

export interface ProviderDefaults {
  contextWindow?: number;
  maxTokens?: number;
  input?: InputCapability[];
  reasoning?: boolean;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  /** 思考档位映射：pi thinking level → provider 参数值；null 标记不支持（off~high 默认支持，xhigh/max 必须显式声明） */
  thinkingLevelMap?: Record<string, string | null>;
}

/** TOML compat 字段名（snake_case）与 JS 字段名（camelCase）的对照 */
export interface CompatOverride {
  thinking_format?: string;
  requires_reasoning_content_on_assistant_messages?: boolean;
  requires_thinking_as_text?: boolean;
  supports_reasoning_effort?: boolean;
  supports_developer_role?: boolean;
  force_adaptive_thinking?: boolean;
  supports_eager_tool_input_streaming?: boolean;
}

export type ProtectedModelAction = "remove" | "update" | "edit";

export interface ModelOverride extends Partial<ProviderDefaults> {
  id: string;
  name?: string;
  /** 保护模型免受指定自动/手动操作影响 */
  do_not?: ProtectedModelAction[];
  /** 锁定价格，reload-online 不覆盖 */
  cost_locked?: boolean;
  /**
   * 一键开启 CoT 回传（thinking_format=deepseek + requires_reasoning_content_on_assistant_messages=true）。
   * 模型级开关；未设置时回退到 provider 级 cotReplay。
   */
  cotReplay?: boolean;
  compat?: CompatOverride;
}

export interface RawProvider {
  id: string;
  name?: string;
  baseUrl: string;
  api?: ApiFormat;
  models?: string | ModelOverride[];
  defaults?: ProviderDefaults;
  /** provider 级 CoT 回传开关，对该 provider 下所有模型生效；模型级 cotReplay 优先 */
  cotReplay?: boolean;
  compat?: CompatOverride;
}

export interface ProvidersConfig {
  providers?: RawProvider[];
}

export interface ResolvedApiFormat {
  format: Exclude<ApiFormat, "auto">;
  baseUrl: string;
}
