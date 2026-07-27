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
  compat?: CompatOverride;
}

export interface RawProvider {
  id: string;
  name?: string;
  baseUrl: string;
  api?: ApiFormat;
  models?: string | ModelOverride[];
  defaults?: ProviderDefaults;
  compat?: CompatOverride;
}

export interface ProvidersConfig {
  providers?: RawProvider[];
}

export interface ResolvedApiFormat {
  format: Exclude<ApiFormat, "auto">;
  baseUrl: string;
}
