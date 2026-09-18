import assert from "node:assert";
import { describe, it } from "node:test";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelCandidate, ModelWithCandidates } from "./models-dev.ts";
import {
  applyOnlineProtection,
  classifyReloadTarget,
  matchModelsDev,
  mergeOneOverride,
  reloadProvidersOnline,
} from "./reload-online.ts";
import { toPiApi } from "./models.ts";
import type { ModelOverride, RawProvider } from "./types.ts";

function runtimeModel(id: string, extra: Partial<ProviderModelConfig> = {}): ProviderModelConfig {
  return {
    id,
    name: extra.name ?? id,
    api: extra.api ?? "openai-completions",
    reasoning: extra.reasoning ?? false,
    input: extra.input ?? ["text"],
    cost: extra.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: extra.contextWindow ?? 128000,
    maxTokens: extra.maxTokens ?? 4096,
    ...extra,
  } as ProviderModelConfig;
}

function provider(id: string, extra: Partial<RawProvider> = {}): RawProvider {
  return {
    id,
    baseUrl: `https://${id}.example.com/v1`,
    api: "openai-old",
    models: [{ id: `${id}-old` }],
    ...extra,
  };
}

describe("classifyReloadTarget", () => {
  it("skips missing api key and auto format", () => {
    assert.deepStrictEqual(classifyReloadTarget(provider("a"), undefined), { kind: "skip", reason: "no-api-key" });
    assert.deepStrictEqual(
      classifyReloadTarget(provider("a", { api: "auto" }), "k"),
      { kind: "skip", reason: "api-auto" },
    );
  });

  it("fetches when api is explicit", () => {
    assert.deepStrictEqual(
      classifyReloadTarget(provider("a", { api: "openai-new" }), "k"),
      { kind: "fetch", format: "openai-new", apiKey: "k" },
    );
  });
});

describe("applyOnlineProtection", () => {
  it("keeps remove-protected models missing from the online list", () => {
    const p = provider("a", {
      models: [
        { id: "kept", do_not: ["remove"] },
        { id: "gone" },
      ],
    });
    const models = applyOnlineProtection([runtimeModel("online")], p, "openai-old");
    assert.deepStrictEqual(models.map(m => m.id), ["online", "kept"]);
  });

  it("replaces update-protected models with the local override", () => {
    const p = provider("a", {
      models: [{ id: "locked", name: "Local", contextWindow: 123, do_not: ["update"] }],
    });
    const models = applyOnlineProtection(
      [runtimeModel("locked", { name: "Online", contextWindow: 999 })],
      p,
      "openai-old",
    );
    assert.strictEqual(models[0].name, "Local");
    assert.strictEqual(models[0].contextWindow, 123);
    assert.strictEqual(models[0].api, toPiApi("openai-old"));
  });
});

describe("matchModelsDev", () => {
  it("dedupes model ids before looking up candidates", async () => {
    const seen: string[] = [];
    const find = async (id: string): Promise<ModelWithCandidates> => {
      seen.push(id);
      return { modelId: id, candidates: [], baseModelCandidates: [] };
    };
    await matchModelsDev(["m1", "m2", "m1"], find, 2);
    assert.deepStrictEqual(seen.sort(), ["m1", "m2"]);
  });
});

describe("mergeOneOverride", () => {
  it("keeps existing config when models.dev has no match", async () => {
    const existing: ModelOverride = { id: "m1", name: "Local", costInput: 1 };
    const merged = await mergeOneOverride(runtimeModel("m1"), existing, undefined);
    assert.strictEqual(merged, existing);
  });

  it("uses models.dev metadata for a new model", async () => {
    const candidate = { providerId: "p", path: "x", providerName: "P" } as ModelCandidate;
    const merged = await mergeOneOverride(runtimeModel("m1"), undefined, candidate, async () => ({
      id: "m1",
      name: "Matched",
      contextWindow: 200000,
      maxTokens: 8192,
      input: ["text", "image"],
      costInput: 1,
      costOutput: 2,
      costCacheRead: 0,
      costCacheWrite: 0,
      reasoning: true,
      source: "p",
    }));
    assert.strictEqual(merged.name, "Matched");
    assert.strictEqual(merged.contextWindow, 200000);
    assert.strictEqual(merged.reasoning, true);
  });
});

describe("reloadProvidersOnline", () => {
  it("fetches eligible providers in parallel and keeps toml order", async () => {
    const inFlight: string[] = [];
    let overlap = 0;
    let started = 0;
    let releaseStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>(resolve => {
      releaseStarted = resolve;
    });

    const providers = [
      provider("slow", { models: [{ id: "slow-old" }] }),
      provider("fast", { models: [{ id: "fast-old" }] }),
      provider("no-key", { models: [{ id: "nk" }] }),
      provider("auto-api", { api: "auto", models: [{ id: "aa" }] }),
    ];

    const outcome = await reloadProvidersOnline(providers, {
      getApiKey: (id) => id === "no-key" ? undefined : `key-${id}`,
      providerConcurrency: 8,
      modelsDevConcurrency: 4,
      resolveModels: async (p) => {
        if (p.models !== "auto") return [runtimeModel(`${p.id}-old`)];
        inFlight.push(p.id);
        started++;
        if (started === 2) releaseStarted?.();
        await bothStarted;
        overlap = Math.max(overlap, inFlight.length);
        inFlight.splice(inFlight.indexOf(p.id), 1);
        return [runtimeModel(`${p.id}-new`)];
      },
      findModelCandidates: async (id) => ({ modelId: id, candidates: [], baseModelCandidates: [] }),
      buildMatchedModel: async (id) => ({
        id,
        name: id,
        contextWindow: 128000,
        maxTokens: 4096,
        input: ["text"],
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
        reasoning: false,
        source: "manual",
      }),
    });

    assert.strictEqual(started, 2);
    assert.ok(overlap >= 2, "two /models fetches should overlap");
    assert.deepStrictEqual(outcome.results.map(r => r.kind), ["ok", "ok", "skip", "skip"]);
    assert.strictEqual(outcome.results[0].kind, "ok");
    assert.strictEqual(outcome.results[1].kind, "ok");
    if (outcome.results[0].kind === "ok") assert.strictEqual(outcome.results[0].provider.id, "slow");
    if (outcome.results[1].kind === "ok") assert.strictEqual(outcome.results[1].provider.id, "fast");
    assert.deepStrictEqual(
      outcome.results.filter((r): r is Extract<typeof r, { kind: "skip" }> => r.kind === "skip").map(r => r.reason),
      ["no-api-key", "api-auto"],
    );
    assert.strictEqual(outcome.totalRefreshed, 2);
    assert.strictEqual(outcome.totalSkipped, 2);
    assert.strictEqual(outcome.totalNew, 2);
    assert.deepStrictEqual(Object.keys(outcome.modelsToWrite), ["slow", "fast"]);
    assert.match(outcome.notices[0].message, /并行拉取 2 个供应商/);
    assert.ok(outcome.notices.some(n => n.message.includes("并行拉取 2 个供应商")));
    assert.deepStrictEqual(
      outcome.notices.filter(n => n.message.startsWith("跳过")).map(n => n.message),
      [
        '跳过 "no-key"：未配置 API Key',
        '跳过 "auto-api"：api 为 "auto"，请先运行 /provider:reload 完成格式检测',
      ],
    );
  });

  it("does not let one failed fetch abort the others", async () => {
    const providers = [
      provider("bad"),
      provider("good", { models: [{ id: "good-old" }] }),
    ];
    const outcome = await reloadProvidersOnline(providers, {
      getApiKey: () => "k",
      resolveModels: async (p) => {
        if (p.id === "bad") throw new Error("boom");
        return [runtimeModel("good-new")];
      },
      findModelCandidates: async (id) => ({ modelId: id, candidates: [], baseModelCandidates: [] }),
    });
    assert.strictEqual(outcome.results[0].kind, "error");
    assert.strictEqual(outcome.results[1].kind, "ok");
    assert.strictEqual(outcome.totalRefreshed, 1);
    assert.strictEqual(outcome.totalSkipped, 1);
    assert.ok(outcome.notices.some(n => n.level === "error" && n.message.includes("boom")));
  });

  it("emits the progress notice before fetches finish", async () => {
    const seen: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const pending = reloadProvidersOnline([provider("slow")], {
      getApiKey: () => "k",
      onNotice: (notice) => seen.push(notice.message),
      resolveModels: async (p) => {
        if (p.models !== "auto") return [runtimeModel("slow-old")];
        await gate;
        return [runtimeModel("slow-new")];
      },
      findModelCandidates: async (id) => ({ modelId: id, candidates: [], baseModelCandidates: [] }),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(seen.some(msg => msg.includes("正在从 \"slow\" 拉取")), "progress should appear while still fetching");
    release?.();
    await pending;
  });

  it("skips a provider that returns an empty model list", async () => {
    const outcome = await reloadProvidersOnline([provider("empty")], {
      getApiKey: () => "k",
      resolveModels: async () => [],
      findModelCandidates: async (id) => ({ modelId: id, candidates: [], baseModelCandidates: [] }),
    });
    assert.strictEqual(outcome.results[0].kind, "empty");
    assert.strictEqual(outcome.totalRefreshed, 0);
    assert.strictEqual(outcome.totalSkipped, 1);
  });
});
