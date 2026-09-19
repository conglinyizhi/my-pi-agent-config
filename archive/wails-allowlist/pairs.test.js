import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pairLabel } from "./pairs.js";

describe("pairLabel", () => {
  it("优先显示名，否则 userId", () => {
    assert.equal(pairLabel({ channel: "im", userId: "u1", displayName: "林" }), "im / 林");
    assert.equal(pairLabel({ channel: "im", userId: "u1" }), "im / u1");
  });
});
