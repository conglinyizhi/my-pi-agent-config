import assert from "node:assert";
import { describe, it } from "node:test";
import { parseProvidersToml } from "./loader.ts";

describe("loader", () => {
  it("parses a valid TOML string", () => {
    const toml = `
[[providers]]
id = "deepseek"
name = "DeepSeek"
base_url = "https://api.deepseek.com"
api = "openai-old"
models = "deepseek-chat"

defaults.context_window = 64000
`;
    const result = parseProvidersToml(toml);
    assert.strictEqual(result.providers && result.providers.length, 1);
    const p = result.providers && result.providers[0];
    assert.ok(p);
    assert.strictEqual(p.id, "deepseek");
    assert.strictEqual(p.name, "DeepSeek");
    assert.strictEqual(p.baseUrl, "https://api.deepseek.com");
    assert.strictEqual(p.api, "openai-old");
    assert.strictEqual(p.models, "deepseek-chat");
    assert.strictEqual(p.defaults && p.defaults.contextWindow, 64000);
  });

  it("rejects provider without id", () => {
    const toml = `
[[providers]]
base_url = "https://example.com"
`;
    assert.throws(() => parseProvidersToml(toml), /id is required/);
  });

  it("rejects provider without base_url", () => {
    const toml = `
[[providers]]
id = "x"
`;
    assert.throws(() => parseProvidersToml(toml), /baseUrl is required/);
  });

  it("parses cot_replay at provider and model level", () => {
    const toml = `
[[providers]]
id = "p"
base_url = "https://example.com"
cot_replay = true

[[providers.models]]
id = "m1"

[[providers.models]]
id = "m2"
cot_replay = false
`;
    const result = parseProvidersToml(toml);
    const p = result.providers && result.providers[0];
    assert.ok(p);
    assert.strictEqual(p.cotReplay, true);
    const models = p.models as Array<{ id: string; cotReplay?: boolean }>;
    assert.strictEqual(models.length, 2);
    assert.strictEqual(models[0].cotReplay, undefined);
    assert.strictEqual(models[1].cotReplay, false);
  });
});
