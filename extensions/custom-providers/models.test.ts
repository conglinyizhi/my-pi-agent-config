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
    const config = buildModelConfig("m1", provider, provider.models[0]);
    assert.strictEqual(config.name, "Model One");
    assert.strictEqual(config.contextWindow, 64000);
    assert.strictEqual(config.maxTokens, 4096);
    assert.strictEqual(config.input[0], "text");
  });
});
