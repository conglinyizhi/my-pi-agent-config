// extensions/subagent-supplement-bridge/index.test.ts — Task 2: worker 补充指令桥接测试
//
// 只 mock 扩展 API 边界（ExtensionAPI.on / sendUserMessage）与 claim 边界
// （注入 fake claim），不断言内部实现；断言真实投递选项（deliverAs: "steer"）
// 与编码文本。timeline 侧（decode 可见性）由 lib/subagent-run.test.ts 的真实
// TimelineBuilder 解析覆盖，这里不重复测 timeline。
//
// 跑法：node --experimental-strip-types extensions/subagent-supplement-bridge/index.test.ts

import assert from "node:assert";
import { describe, it, afterEach } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createSupplementToolEndHandler,
  registerSupplementBridge,
  type ToolEndEventShape,
} from "./index.ts";
import registerBridge from "./index.ts";
import { encodeSupplementMessage } from "../../lib/subagent-supplement.ts";

interface SentCall {
  content: string;
  options?: { deliverAs: "steer" };
}

function mockPi() {
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
  const sent: SentCall[] = [];
  const api = {
    on: (event: string, handler: (event: unknown) => Promise<unknown>) => {
      handlers.set(event, handler);
    },
    sendUserMessage: (content: string, options?: { deliverAs: "steer" }) => {
      sent.push({ content, options });
    },
  };
  return { pi: api as unknown as ExtensionAPI, handlers, sent };
}

function toolEndEvent(isError: boolean): ToolEndEventShape {
  return {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    result: { ok: 1 },
    isError,
  };
}

function fakeClaim(claimed: { id: string; text: string } | null) {
  let calls = 0;
  const fn = async (): Promise<{ claimed: { id: string; text: string } | null }> => {
    calls++;
    return { claimed };
  };
  fn.calls = () => calls;
  return fn;
}

function fakeRelease() {
  const calls: Array<{ inboxId: string; entryId: string }> = [];
  const fn = async (
    inboxId: string,
    entryId: string,
  ): Promise<{ released: boolean }> => {
    calls.push({ inboxId, entryId });
    return { released: true };
  };
  fn.calls = () => calls;
  return fn;
}

afterEach(() => {
  delete process.env.PI_SUBAGENT_INBOX;
});

describe("createSupplementToolEndHandler（工厂：可注入 claim 与 send）", () => {
  it("工具成功完成时 claim 一次并按编码文本投递", async () => {
    const claim = fakeClaim({ id: "e1", text: "补充：重试" });
    const release = fakeRelease();
    const sent: SentCall[] = [];
    const handler = createSupplementToolEndHandler({
      inboxId: "test-inbox",
      claim,
      release,
      send: (content, options) => sent.push({ content, options }),
    });
    await handler(toolEndEvent(false));
    assert.strictEqual(claim.calls(), 1);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].content, encodeSupplementMessage("e1", "补充：重试"));
    assert.deepStrictEqual(sent[0].options, { deliverAs: "steer" });
    assert.deepStrictEqual(release.calls(), []); // 成功投递不 release：条目保持 handoff
  });

  it("工具失败完成同样 claim 并投递（不看 isError）", async () => {
    const claim = fakeClaim({ id: "e2", text: "补充：换路径" });
    const release = fakeRelease();
    const sent: SentCall[] = [];
    const handler = createSupplementToolEndHandler({
      inboxId: "test-inbox",
      claim,
      release,
      send: (content, options) => sent.push({ content, options }),
    });
    await handler(toolEndEvent(true));
    assert.strictEqual(claim.calls(), 1);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].content, encodeSupplementMessage("e2", "补充：换路径"));
    assert.deepStrictEqual(sent[0].options, { deliverAs: "steer" });
    assert.deepStrictEqual(release.calls(), []);
  });

  it("一次回调恰好 claim 一条；无 pending（claimed null）时不投递", async () => {
    const claim = fakeClaim(null);
    const release = fakeRelease();
    const sent: SentCall[] = [];
    const handler = createSupplementToolEndHandler({
      inboxId: "test-inbox",
      claim,
      release,
      send: (content, options) => sent.push({ content, options }),
    });
    await handler(toolEndEvent(false));
    assert.strictEqual(claim.calls(), 1);
    assert.strictEqual(sent.length, 0); // claimed null → 不发
    assert.deepStrictEqual(release.calls(), []);
  });
});

describe("createSupplementToolEndHandler（send 同步抛错 → 回滚 release）", () => {
  it("send throw 时精确调用一次 release 并 rethrow 原始错误", async () => {
    const claim = fakeClaim({ id: "e1", text: "补充：重试" });
    const release = fakeRelease();
    const boom = new Error("enqueue rejected");
    const handler = createSupplementToolEndHandler({
      inboxId: "test-inbox",
      claim,
      release,
      send: () => {
        throw boom;
      },
    });
    await assert.rejects(handler(toolEndEvent(false)), (err) => err === boom);
    assert.strictEqual(claim.calls(), 1);
    assert.deepStrictEqual(release.calls(), [{ inboxId: "test-inbox", entryId: "e1" }]);
  });

  it("成功投递（send 正常返回）不调用 release——条目保持 handoff", async () => {
    const claim = fakeClaim({ id: "e1", text: "补充" });
    const release = fakeRelease();
    const sent: SentCall[] = [];
    const handler = createSupplementToolEndHandler({
      inboxId: "test-inbox",
      claim,
      release,
      send: (content, options) => sent.push({ content, options }),
    });
    await handler(toolEndEvent(false));
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(release.calls(), []);
  });

  it("工具失败完成同样走 release-on-throw 路径（不看 isError）", async () => {
    const claim = fakeClaim({ id: "e2", text: "补充" });
    const release = fakeRelease();
    const boom = new Error("enqueue rejected");
    const handler = createSupplementToolEndHandler({
      inboxId: "test-inbox",
      claim,
      release,
      send: () => {
        throw boom;
      },
    });
    await assert.rejects(handler(toolEndEvent(true)), (err) => err === boom);
    assert.deepStrictEqual(release.calls(), [{ inboxId: "test-inbox", entryId: "e2" }]);
  });

  it("claimed null 时既不 send 也不 release", async () => {
    const claim = fakeClaim(null);
    const release = fakeRelease();
    const sent: SentCall[] = [];
    const handler = createSupplementToolEndHandler({
      inboxId: "test-inbox",
      claim,
      release,
      send: (content, options) => sent.push({ content, options }),
    });
    await handler(toolEndEvent(false));
    assert.strictEqual(sent.length, 0);
    assert.deepStrictEqual(release.calls(), []);
  });

  it("release 也失败时仍抛原始 send 错误（尽力回滚，不吞掉原错）", async () => {
    const claim = fakeClaim({ id: "e1", text: "补充" });
    const boom = new Error("enqueue rejected");
    const handler = createSupplementToolEndHandler({
      inboxId: "test-inbox",
      claim,
      release: async () => {
        throw new Error("release also failed");
      },
      send: () => {
        throw boom;
      },
    });
    await assert.rejects(handler(toolEndEvent(false)), (err) => err === boom);
  });
});

describe("registerSupplementBridge（默认接线：真实 Pi API 投递路径）", () => {
  it("有效 inbox 时注册 handler，成功/失败完成都经 pi.sendUserMessage 以 steer 投递", async () => {
    const { pi, handlers, sent } = mockPi();
    const claim = fakeClaim({ id: "e3", text: "补充：校验 diff" });
    const registered = registerSupplementBridge(pi, { inboxId: "batch-1", claim });
    assert.strictEqual(registered, true);
    const handler = handlers.get("tool_execution_end");
    assert.ok(handler, "tool_execution_end handler 已注册");
    await handler(toolEndEvent(false));
    await handler(toolEndEvent(true));
    assert.strictEqual(claim.calls(), 2); // 每次回调恰好 claim 一次
    assert.strictEqual(sent.length, 2);
    for (const call of sent) {
      assert.strictEqual(call.content, encodeSupplementMessage("e3", "补充：校验 diff"));
      assert.deepStrictEqual(call.options, { deliverAs: "steer" });
    }
  });

  it("register 路径：send 抛错时用注入的 release 回滚并 rethrow 原始错误", async () => {
    const { pi, handlers } = mockPi();
    const claim = fakeClaim({ id: "e4", text: "补充：校验 diff" });
    const release = fakeRelease();
    const boom = new Error("enqueue rejected");
    const registered = registerSupplementBridge(pi, {
      inboxId: "batch-1",
      claim,
      release,
      send: () => {
        throw boom;
      },
    });
    assert.strictEqual(registered, true);
    const handler = handlers.get("tool_execution_end");
    assert.ok(handler, "tool_execution_end handler 已注册");
    await assert.rejects(handler(toolEndEvent(false)), (err) => err === boom);
    assert.deepStrictEqual(release.calls(), [{ inboxId: "batch-1", entryId: "e4" }]);
  });

  it("无有效 inbox（缺 env / 非法值）时不注册 handler、不抛", () => {
    // 缺 env
    const p1 = mockPi();
    assert.strictEqual(registerBridge(p1.pi), false);
    assert.ok(!p1.handlers.has("tool_execution_end"));
    assert.strictEqual(p1.sent.length, 0);
    // 非法值（含路径穿越字符）
    const p2 = mockPi();
    process.env.PI_SUBAGENT_INBOX = "../evil";
    assert.strictEqual(registerBridge(p2.pi), false);
    assert.ok(!p2.handlers.has("tool_execution_end"));
    // 空串
    const p3 = mockPi();
    process.env.PI_SUBAGENT_INBOX = "";
    assert.strictEqual(registerBridge(p3.pi), false);
    assert.ok(!p3.handlers.has("tool_execution_end"));
  });

  it("env 提供有效 inbox 时 default extension 注册 handler", () => {
    const { pi, handlers } = mockPi();
    process.env.PI_SUBAGENT_INBOX = "worker-7";
    assert.strictEqual(registerBridge(pi), true);
    assert.ok(handlers.has("tool_execution_end"));
  });
});
