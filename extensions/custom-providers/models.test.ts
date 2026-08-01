import assert from "node:assert";
import { describe, it } from "node:test";
import { buildModelConfig, parseModelIds } from "./models.ts";
import type { RawProvider } from "./types.ts";

describe("models", () => {
  it("parses comma-separated model ids", () => {
    const ids = parseModelIds("model-a, model-b");
    assert.deepStrictEqual(ids, ["model-a", "model-b"]);
  });

  it("applies defaults and overrides", () => {
    const provider: RawProvider = {
      id: "p",
      baseUrl: "https://example.com",
      defaults: { contextWindow: 64000, maxTokens: 8192 },
      models: [{ id: "m1", name: "Model One", maxTokens: 4096 }],
    };
    const config = buildModelConfig("m1", provider, (provider.models as { id: string; name: string; maxTokens: number }[])[0]);
    assert.strictEqual(config.name, "Model One");
    assert.strictEqual(config.contextWindow, 64000);
    assert.strictEqual(config.maxTokens, 4096);
    assert.strictEqual(config.input[0], "text");
  });

  it("cot_replay at model level enables deepseek CoT compat", () => {
    const provider: RawProvider = {
      id: "p",
      baseUrl: "https://example.com",
      models: [{ id: "kimi-k3", cotReplay: true }],
    };
    const config = buildModelConfig("kimi-k3", provider, { id: "kimi-k3", cotReplay: true });
    const compat = config.compat as { thinkingFormat?: string; requiresReasoningContentOnAssistantMessages?: boolean } | undefined;
    assert.strictEqual(compat?.thinkingFormat, "deepseek");
    assert.strictEqual(compat?.requiresReasoningContentOnAssistantMessages, true);
  });

  it("cot_replay at provider level applies to all models", () => {
    const provider: RawProvider = {
      id: "p",
      baseUrl: "https://example.com",
      cotReplay: true,
      models: [{ id: "m1" }],
    };
    const config = buildModelConfig("m1", provider, { id: "m1" });
    const compat = config.compat as { thinkingFormat?: string; requiresReasoningContentOnAssistantMessages?: boolean } | undefined;
    assert.strictEqual(compat?.thinkingFormat, "deepseek");
    assert.strictEqual(compat?.requiresReasoningContentOnAssistantMessages, true);
  });

  it("explicit model compat overrides cot_replay expansion", () => {
    const provider: RawProvider = {
      id: "p",
      baseUrl: "https://example.com",
      models: [{ id: "m1", cotReplay: true, compat: { thinking_format: "openrouter" } }],
    };
    const config = buildModelConfig("m1", provider, {
      id: "m1",
      cotReplay: true,
      compat: { thinking_format: "openrouter" },
    });
    const compat = config.compat as { thinkingFormat?: string; requiresReasoningContentOnAssistantMessages?: boolean } | undefined;
    assert.strictEqual(compat?.thinkingFormat, "openrouter");
    assert.strictEqual(compat?.requiresReasoningContentOnAssistantMessages, true);
  });
});
