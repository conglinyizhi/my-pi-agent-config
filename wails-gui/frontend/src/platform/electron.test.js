// 跑法：node --test src/platform/electron.test.js
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElectronPlatform } from "./electron.js";
import { createPlatform, platformKind } from "./detect.js";

function stubApi() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
    return Promise.resolve(name);
  };
  return {
    calls,
    api: {
      session: { getWindowName: record("windowName"), getInitData: record("initData"), markReady: record("markReady"), submit: record("submit"), close: record("close") },
      capabilities: { openFile: record("openFile"), copyText: record("copyText") },
      gate: { loadReasons: record("loadReasons"), saveReason: record("saveReason"), updateReason: record("updateReason"), deleteReason: record("deleteReason") },
      subagents: { getStatus: record("getStatus"), getDiagnostics: record("getDiagnostics"), getDiagnostic: record("getDiagnostic"), deleteDiagnostic: record("deleteDiagnostic"), queueSupplement: record("queueSupplement"), withdrawSupplement: record("withdrawSupplement"), mergeSupplements: record("mergeSupplements") },
    },
  };
}

describe("Electron 平台适配器", () => {
  it("缺 preload 接口时明确报错，不静默空转", () => {
    assert.throws(() => createElectronPlatform(undefined), /preload 没挂上/);
  });

  it("提交前把响应 stringify（与 Wails 版同口径）", async () => {
    const { api, calls } = stubApi();
    const platform = createElectronPlatform(api);
    await platform.session.submit({ action: "allow", comment: "行" });
    assert.deepEqual(calls.at(-1), ["submit", '{"action":"allow","comment":"行"}']);
  });

  it("各分组照原样透传", async () => {
    const { api, calls } = stubApi();
    const platform = createElectronPlatform(api);
    await platform.capabilities.copyText("x");
    await platform.gate.loadReasons();
    await platform.subagents.getStatus();
    assert.deepEqual(calls.map((c) => c[0]), ["copyText", "loadReasons", "getStatus"]);
  });
});

describe("平台选择", () => {
  it("有 piGui 走 Electron，有 go/runtime 走 Wails", () => {
    assert.equal(platformKind({ piGui: {} }), "electron");
    assert.equal(platformKind({ go: {} }), "wails");
    assert.equal(platformKind({}), "unknown");
    assert.equal(typeof createPlatform({ piGui: stubApi().api }).session.getInitData, "function");
  });
});
