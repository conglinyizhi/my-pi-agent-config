import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateDecisionSummary } from "./summary.js";

describe("Gate decision summary", () => {
  it("keeps capability approval explicitly one-shot", () => {
    const summary = gateDecisionSummary({ kind: "capability", capability: "network" });
    assert.equal(summary.tone, "info");
    assert.match(summary.text, /当前命令/);
  });

  it("distinguishes full access and write-path escalation", () => {
    assert.equal(gateDecisionSummary({ kind: "sandbox-allow", permission: "full-access" }).tone, "danger");
    assert.equal(gateDecisionSummary({ kind: "sandbox-allow", permission: "write-paths" }).tone, "warning");
  });

  it("surfaces dangerous review before ordinary rule count", () => {
    assert.equal(gateDecisionSummary({ kind: "audit", rules: [{}], review: { verdict: "dangerous" } }).tone, "danger");
    assert.match(gateDecisionSummary({ kind: "audit", rules: [{}, {}] }).text, /2/);
  });
});
