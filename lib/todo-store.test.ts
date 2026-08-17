// todo-store.test.ts — 统一 dsh-todo 存储折叠/写入语义
// 跑法：node --experimental-strip-types lib/todo-store.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSteps, writeSteps, TODO_ENTRY_TYPE, type Step } from "./todo-store.ts";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

function entry(todos: Step[]): SessionEntry {
  return { type: "custom", customType: "dsh-todo", data: { todos } } as unknown as SessionEntry;
}

describe("readSteps（dsh-todo last-wins 折叠）", () => {
  it("无 entry 返回 null", () => {
    assert.equal(readSteps([]), null);
  });

  it("折叠最后一条 dsh-todo，忽略中间快照", () => {
    const entries = [
      entry([{ content: "a", status: "pending" }]),
      entry([{ content: "b", status: "completed" }]),
    ];
    assert.deepEqual(readSteps(entries), [{ content: "b", status: "completed" }]);
  });

  it("忽略非 dsh-todo 的 custom entry", () => {
    const other = { type: "custom", customType: "plan-mode", data: { enabled: true } } as unknown as SessionEntry;
    assert.equal(readSteps([other]), null);
  });
});

describe("writeSteps（追加 dsh-todo entry）", () => {
  it("写入全量快照", () => {
    const recorded: { type: string; data: unknown }[] = [];
    const pi = {
      appendEntry: (type: string, data: unknown) => void recorded.push({ type, data }),
    } as unknown as ExtensionAPI;
    writeSteps(pi, [{ content: "a", status: "pending" }]);
    assert.deepEqual(recorded, [
      { type: TODO_ENTRY_TYPE, data: { todos: [{ content: "a", status: "pending" }] } },
    ]);
  });
});
