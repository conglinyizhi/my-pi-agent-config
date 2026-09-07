import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMainAgentHandoff, isActiveWorkerStatus, pendingSupplements, workerSupplements } from "./supplements.js";

describe("subagent supplements", () => {
  it("classifies active worker statuses", () => {
    assert.equal(isActiveWorkerStatus("starting"), true);
    assert.equal(isActiveWorkerStatus("running"), true);
    assert.equal(isActiveWorkerStatus("success"), false);
  });

  it("filters pending entries without mutating the worker data", () => {
    const worker = { supplements: [{ id: "a", state: "pending", text: "first" }, { id: "b", state: "handoff", text: "sent" }] };
    assert.equal(workerSupplements(worker), worker.supplements);
    assert.deepEqual(pendingSupplements(worker).map((entry) => entry.id), ["a"]);
  });

  it("builds browser-independent handoff text from draft and pending FIFO entries", () => {
    const worker = { supplements: [
      { id: "a", state: "pending", text: "first" },
      { id: "b", state: "handoff", text: "already sent" },
      { id: "c", state: "pending", text: "second" },
    ] };
    assert.equal(buildMainAgentHandoff(worker, "  draft  "), "draft\n\nfirst\n\n--- Supplement 2 ---\n\nsecond");
    assert.equal(buildMainAgentHandoff(undefined, "draft"), "");
  });
});
