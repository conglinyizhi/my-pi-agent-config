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

export interface ModelOverride extends Partial<ProviderDefaults> {
  id: string;
  name?: string;
}

export interface RawProvider {
  id: string;
  name?: string;
  baseUrl: string;
  api?: ApiFormat;
  models?: string | ModelOverride[];
  defaults?: ProviderDefaults;
}

export interface ProvidersConfig {
  providers?: RawProvider[];
}

export interface ResolvedApiFormat {
  format: Exclude<ApiFormat, "auto">;
  baseUrl: string;
}
