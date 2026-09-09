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

  it("mutates only mock subagent state through the adapter methods", async () => {
    const platform = createBrowserPlatform({ workers: [{ id: "w", inboxId: "i", supplements: [] }] });
    await platform.subagents.queueSupplement("i", "note");
    const afterQueue = JSON.parse(await platform.subagents.getStatus());
    assert.equal(afterQueue.workers[0].supplements[0].text, "note");
    await platform.subagents.withdrawSupplement("i", afterQueue.workers[0].supplements[0].id);
    assert.deepEqual(JSON.parse(await platform.subagents.getStatus()).workers[0].supplements, []);
  });
});
