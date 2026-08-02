export type ApiFormat = "openai-new" | "openai-old" | "anthropic" | "auto";

export type KnownApi = "openai-responses" | "openai-completions" | "anthropic-messages";

export type InputCapability = "text" | "image";

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

export interface ModelOverride extends Partial<ProviderDefaults> {
  id: string;
  name?: string;
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
