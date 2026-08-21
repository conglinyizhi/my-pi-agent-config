/** /provider:fast-del — 交互式删除自定义供应商 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { parse, stringify } from "smol-toml";

const CONFIG_PATH = `${getAgentDir()}/providers.toml`;
const AUTH_PATH = `${getAgentDir()}/auth.json`;

export interface DeletableProvider {
  id: string;
  name?: string;
  baseUrl?: string;
}

function loadProviders(): { providers: DeletableProvider[]; config: Record<string, unknown> } | null {
  try {
    const config = parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
    const rawProviders = config.providers;
    if (!Array.isArray(rawProviders)) return null;

    const providers = rawProviders
      .filter((provider): provider is Record<string, unknown> => Boolean(provider && typeof provider === "object"))
      .map(provider => ({
        id: String(provider.id ?? ""),
        name: typeof provider.name === "string" ? provider.name : undefined,
        baseUrl: typeof provider.base_url === "string" ? provider.base_url : undefined,
      }))
      .filter(provider => provider.id);

    return { providers, config };
  } catch {
    return null;
  }
}

/** 返回 query 命中 id、name 或地址的 provider；空 query 返回全部。 */
export function findProviderMatches(
  providers: DeletableProvider[],
  query: string,
): DeletableProvider[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return providers;
  return providers.filter(provider =>
    [provider.id, provider.name, provider.baseUrl]
      .filter(Boolean)
      .some(value => value!.toLocaleLowerCase().includes(normalized)),
  );
}

function providerLabel(provider: DeletableProvider): string {
  const suffix = provider.name && provider.name !== provider.id ? ` | ${provider.name}` : "";
  return `${provider.id}${suffix}${provider.baseUrl ? ` | ${provider.baseUrl}` : ""}`;
}

async function chooseProvider(
  ctx: ExtensionCommandContext,
  providers: DeletableProvider[],
  query: string,
): Promise<DeletableProvider | null> {
  const matches = findProviderMatches(providers, query);
  if (matches.length === 0) {
    ctx.ui.notify(query ? `没有匹配的供应商: ${query}` : "没有可删除的供应商", "info");
    return null;
  }

  if (matches.length === 1) return matches[0];

  const selected = await ctx.ui.select(
    `找到 ${matches.length} 个匹配项，请选择要删除的供应商：`,
    matches.map(providerLabel),
  );
  if (!selected) return null;
  return matches.find(provider => providerLabel(provider) === selected) ?? null;
}

function removeAuthEntry(providerId: string): void {
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, unknown>;
    if (!(providerId in auth)) return;
    delete auth[providerId];
    writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2) + "\n", "utf8");
  } catch {
    // auth.json 不存在或不是 JSON 时，providers.toml 仍然可以删除。
  }
}

export async function fastDelHandler(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const loaded = loadProviders();
  if (!loaded) {
    ctx.ui.notify("providers.toml 不存在或格式无效", "info");
    return;
  }

  const selected = await chooseProvider(ctx, loaded.providers, args);
  if (!selected) return;

  const confirmed = await ctx.ui.confirm(
    "确认删除供应商？",
    `${providerLabel(selected)}\n\n将从 providers.toml 和 auth.json 移除，并注销运行时 provider。`,
  );
  if (!confirmed) {
    ctx.ui.notify("已取消", "info");
    return;
  }

  const rawProviders = loaded.config.providers;
  if (!Array.isArray(rawProviders)) return;
  loaded.config.providers = rawProviders.filter(provider =>
    !(provider && typeof provider === "object" && (provider as Record<string, unknown>).id === selected.id),
  );

  try {
    writeFileSync(CONFIG_PATH, stringify(loaded.config), "utf8");
    removeAuthEntry(selected.id);
    pi.unregisterProvider(selected.id);
    ctx.ui.notify(`供应商 "${selected.id}" 已删除`, "info");
  } catch (err) {
    ctx.ui.notify(`删除失败: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}
