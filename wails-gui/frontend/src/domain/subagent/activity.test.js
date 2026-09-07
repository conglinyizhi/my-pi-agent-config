import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityState } from "./activity.js";

describe("worker activity state", () => {
  const now = Date.parse("2026-09-07T12:10:00.000Z");
  it("marks ordinary, quiet and stalled workers without changing their status", () => {
    assert.equal(activityState({ status: "running", lastActivityAt: "2026-09-07T12:09:40.000Z" }, now).level, "active");
    assert.equal(activityState({ status: "running", lastActivityAt: "2026-09-07T12:08:00.000Z" }, now).level, "quiet");
    assert.equal(activityState({ status: "running", lastActivityAt: "2026-09-07T12:04:00.000Z" }, now).level, "stalled");
  });
  it("labels capability waits separately", () => {
    assert.equal(activityState({ status: "needs_approval", lastActivityAt: "2026-09-07T12:09:00.000Z" }, now).level, "waiting");
  });
});
