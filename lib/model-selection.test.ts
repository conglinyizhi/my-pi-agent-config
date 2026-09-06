import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getAvailableModels,
  parseModelSpec,
  resolveModel,
  setCurrentSessionModel,
} from "./model-selection.ts";

const models = [
  { provider: "alpha", id: "fast", name: "Fast", maxTokens: 1 },
  { provider: "alpha", id: "slow", name: "Slow", maxTokens: 1 },
  { provider: "beta", id: "vision", name: "Vision", maxTokens: 1 },
];

function context(authenticated: Set<string> = new Set(["alpha/fast", "alpha/slow", "beta/vision"])) {
  return {
    hasUI: false,
    modelRegistry: {
      getAll: () => models,
      find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
      hasConfiguredAuth: (model: { provider: string; id: string }) => authenticated.has(`${model.provider}/${model.id}`),
    },
  } as any;
}

describe("model selection shared utilities", () => {
  it("parses provider/model and rejects malformed specs", () => {
    assert.deepEqual(parseModelSpec("alpha/fast"), { provider: "alpha", id: "fast" });
    assert.deepEqual(parseModelSpec("alpha/a/b"), { provider: "alpha", id: "a/b" });
    assert.equal(parseModelSpec("alpha"), undefined);
    assert.equal(parseModelSpec("/fast"), undefined);
    assert.equal(parseModelSpec("alpha/"), undefined);
  });

  it("filters models by configured authentication", () => {
    const available = getAvailableModels(context(new Set(["beta/vision"]))).map((m) => `${m.provider}/${m.id}`);
    assert.deepEqual(available, ["beta/vision"]);
  });

  it("resolves a registered model by exact provider/model", () => {
    assert.equal(resolveModel(context(), "alpha/fast")?.id, "fast");
    assert.equal(resolveModel(context(), "missing/fast"), undefined);
  });

  it("sets only the current session model and does not persist a default", async () => {
    const selected: unknown[] = [];
    const result = await setCurrentSessionModel(
      { setModel: async (model: unknown) => { selected.push(model); return true; } } as any,
      context(),
      "beta/vision",
    );
    assert.equal(result.ok, true);
    assert.equal(selected.length, 1);
    assert.deepEqual(selected[0], models[2]);
  });

  it("rejects an unauthenticated explicit model before calling setModel", async () => {
    let called = false;
    const result = await setCurrentSessionModel(
      { setModel: async () => { called = true; return true; } } as any,
      context(new Set()),
      "alpha/fast",
    );
    assert.deepEqual(result, { ok: false, reason: "unauthenticated" });
    assert.equal(called, false);
  });
});
