import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getAvailableModels,
  orderAvailableModelsForPreferences,
  preferredModelSpec,
  pinnedModelActionOptions,
  selectModel,
  parseModelSpec,
  resolveModel,
  setCurrentSessionModel,
  withPinnedModel,
  withRecordedModel,
  withSelectedModel,
  withUnpinnedModel,
  type ModelPreferences,
} from "./model-selection.ts";

const models = [
  { provider: "alpha", id: "fast", name: "Fast", maxTokens: 1 },
  { provider: "alpha", id: "slow", name: "Slow", maxTokens: 1 },
  { provider: "beta", id: "vision", name: "Vision", maxTokens: 1 },
];

function context(
  authenticated: Set<string> = new Set(["alpha/fast", "alpha/slow", "beta/vision"]),
  ui?: { select: (message: string, options: string[]) => Promise<string | undefined> },
) {
  return {
    hasUI: ui !== undefined,
    ui,
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

  it("orders scoped pins, global pins, then recent models", () => {
    const ordered = orderAvailableModelsForPreferences(models as any, {
      globalPinned: [{ provider: "beta", id: "vision" }],
      scopes: {
        default: {
          pinned: [{ provider: "alpha", id: "slow" }],
          recent: [{ provider: "alpha", id: "fast" }],
        },
      },
    });
    assert.deepEqual(ordered.map((model) => `${model.provider}/${model.id}`), [
      "alpha/slow",
      "beta/vision",
      "alpha/fast",
    ]);
  });

  it("keeps four recent models per scope and excludes pinned models", () => {
    let preferences: ModelPreferences = { globalPinned: [], scopes: {} };
    for (const id of ["one", "two", "three", "four", "five"]) {
      preferences = withRecordedModel(preferences, { provider: "alpha", id }, "tool-a");
    }
    assert.deepEqual(preferences.scopes["tool-a"].recent.map((model) => model.id), [
      "five", "four", "three", "two",
    ]);

    preferences = withPinnedModel(preferences, { provider: "alpha", id: "four" }, "tool-a", "scope");
    assert.deepEqual(preferences.scopes["tool-a"].pinned.map((model) => model.id), ["four"]);
    assert.deepEqual(preferences.scopes["tool-a"].recent.map((model) => model.id), ["five", "three", "two"]);
    preferences = withRecordedModel(preferences, { provider: "alpha", id: "four" }, "tool-a");
    assert.deepEqual(preferences.scopes["tool-a"].recent.map((model) => model.id), ["five", "three", "two"]);
  });

  it("keeps scoped recent and pins isolated between plugins", () => {
    let preferences: ModelPreferences = { globalPinned: [], scopes: {} };
    preferences = withRecordedModel(preferences, { provider: "alpha", id: "fast" }, "tool-a");
    preferences = withPinnedModel(preferences, { provider: "alpha", id: "slow" }, "tool-a", "scope");
    preferences = withRecordedModel(preferences, { provider: "beta", id: "vision" }, "tool-b");
    assert.deepEqual(preferences.scopes["tool-a"], {
      selected: undefined,
      recent: [{ provider: "alpha", id: "fast" }],
      pinned: [{ provider: "alpha", id: "slow" }],
    });
    assert.deepEqual(preferences.scopes["tool-b"], {
      recent: [{ provider: "beta", id: "vision" }],
      pinned: [],
    });
  });

  it("global pins are visible to all scopes and can be unpinned independently", () => {
    let preferences: ModelPreferences = {
      globalPinned: [],
      scopes: {
        "tool-a": { selected: undefined, recent: [{ provider: "beta", id: "vision" }], pinned: [] },
        "tool-b": { selected: undefined, recent: [{ provider: "beta", id: "vision" }], pinned: [] },
      },
    };
    preferences = withPinnedModel(preferences, { provider: "beta", id: "vision" }, "tool-a", "global");
    assert.deepEqual(preferences.globalPinned, [{ provider: "beta", id: "vision" }]);
    assert.deepEqual(preferences.scopes["tool-a"].recent, []);
    assert.deepEqual(preferences.scopes["tool-b"].recent, []);
    preferences = withUnpinnedModel(preferences, { provider: "beta", id: "vision" }, "tool-a", "global");
    assert.deepEqual(preferences.globalPinned, []);
  });

  it("uses explicit worker model before scoped default before session model", () => {
    assert.deepEqual(preferredModelSpec("explicit/model", { provider: "saved", id: "model" }, "session/model"), {
      spec: "explicit/model", source: "explicit",
    });
    assert.deepEqual(preferredModelSpec(undefined, { provider: "saved", id: "model" }, "session/model"), {
      spec: "saved/model", source: "scoped-default",
    });
    assert.deepEqual(preferredModelSpec(undefined, undefined, "session/model"), {
      spec: "session/model", source: "session",
    });
  });

  it("stores an independent selected model without changing recent or pinned", () => {
    const initial: ModelPreferences = {
      globalPinned: [],
      scopes: { "tool-a": { selected: undefined, recent: [], pinned: [] } },
    };
    const selected = withSelectedModel(initial, "tool-a", { provider: "alpha", id: "fast" });
    assert.deepEqual(selected.scopes["tool-a"].selected, { provider: "alpha", id: "fast" });
    assert.deepEqual(selected.scopes["tool-a"].recent, []);
    const inherited = withSelectedModel(selected, "tool-a");
    assert.equal(inherited.scopes["tool-a"].selected, undefined);
  });

  it("offers select, matching unpin actions, and back for pinned models", () => {
    assert.deepEqual(pinnedModelActionOptions({ scope: true, global: false }), [
      "选择这个置顶模型", "取消当前功能置顶", "返回上一级",
    ]);
    assert.deepEqual(pinnedModelActionOptions({ scope: true, global: true }), [
      "选择这个置顶模型", "取消当前功能置顶", "取消所有功能置顶", "返回上一级",
    ]);
  });

  it("requires confirmation for an explicit model and cancels before session change", async () => {
    const selected: string[] = [];
    const result = await selectModel(
      context(new Set(["beta/vision"]), {
        select: async (message, options) => {
          selected.push(`${message} :: ${options.join("|")}`);
          return "取消";
        },
      }),
      "beta/vision",
    );
    assert.deepEqual(result, { ok: false, reason: "cancelled" });
    assert.match(selected[0], /确认使用模型：beta\/vision/);
    assert.match(selected[0], /确认使用\|当前功能置顶并确认\|所有功能置顶并确认\|取消/);
  });

  it("sets only the current session model and does not persist a default", async () => {
    const selected: unknown[] = [];
    const result = await setCurrentSessionModel(
      { setModel: async (model: unknown) => { selected.push(model); return true; } } as any,
      context(),
      "beta/vision",
      { persistLastModel: false },
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
