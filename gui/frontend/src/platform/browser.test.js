import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBrowserPlatform } from "./browser.js";

describe("browser platform adapter", () => {
  it("keeps the shared session contract without Wails globals", async () => {
    const submitted = [];
    const platform = createBrowserPlatform({ workers: [] }, { onSubmit: (response) => submitted.push(response) });
    assert.deepEqual(await platform.session.getInitData(), { workers: [] });
    await platform.session.submit({ action: "allow" });
    assert.deepEqual(submitted, [{ action: "allow" }]);
    await platform.session.close();
  });

  it("supports adding, editing, and deleting a reason", async () => {
    const platform = createBrowserPlatform({});
    await platform.gate.saveReason("原始附言");
    assert.equal((await platform.gate.loadReasons())[0].content, "原始附言");
    await platform.gate.updateReason("原始附言", "编辑后的附言");
    assert.deepEqual((await platform.gate.loadReasons()).map((reason) => reason.content), ["编辑后的附言"]);
    await platform.gate.deleteReason("编辑后的附言");
    assert.deepEqual(await platform.gate.loadReasons(), []);
  });

  it("review：预览里改内存，并明说没有 initData.settings 时保存不了", async () => {
    const platform = createBrowserPlatform({
      settings: {
        llm: { enabled: true, mode: "auto", backend: "chain", timeoutMs: 30000, tokenIdleMs: 4000, maxCache: 200 },
        classifier: { baseUrl: "https://api.siliconflow.cn", model: "m", timeoutMs: 3000 },
        dimensions: [{ id: "elevation", enabled: true, above: 0.5, below: 0.5, action: "review" }],
        warnings: [],
      },
      specs: [],
      limits: { step: 0.05 },
    });
    const loaded = await platform.review.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.settings.llm.mode, "auto");

    const saved = await platform.review.save({ llm: { mode: "strict" }, dimensions: [{ id: "elevation", above: 0.7 }] });
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.changed, ["llm.mode: auto → strict", "elevation.above: 0.5 → 0.7"]);
    assert.equal((await platform.review.load()).settings.dimensions[0].above, 0.7);

    const bare = createBrowserPlatform({});
    assert.equal((await bare.review.load()).ok, false);
    assert.equal((await bare.review.save({})).ok, false);
  });

  it("mutates only mock subagent state through the adapter methods", async () => {
    const platform = createBrowserPlatform({ workers: [{ id: "w", inboxId: "i", supplements: [] }] });
    await platform.subagents.queueSupplement("i", "note");
    const afterQueue = JSON.parse(await platform.subagents.getStatus());
    assert.equal(afterQueue.workers[0].supplements[0].text, "note");
    await platform.subagents.withdrawSupplement("i", afterQueue.workers[0].supplements[0].id);
    assert.deepEqual(JSON.parse(await platform.subagents.getStatus()).workers[0].supplements, []);
  });
});
