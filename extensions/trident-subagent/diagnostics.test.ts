import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { archiveDiagnostics, beginDiagnostics, clearDiagnosticsContext, configureDiagnosticsRoot } from "./diagnostics.ts";

const root = mkdtempSync(join(tmpdir(), "pi-subagent-diagnostics-"));
after(() => { configureDiagnosticsRoot(); rmSync(root, { recursive: true, force: true }); });

describe("subagent diagnostics archive", () => {
  it("writes only the explicit visible snapshot and prompt reconstruction inputs", () => {
    configureDiagnosticsRoot(root);
    beginDiagnostics({
      batchId: "batch-test123", createdAt: "2026-09-07T00:00:00.000Z", cwd: "/work", model: "test/model", workerPrompt: "worker rules",
      systemPrompt: { kind: "reconstructable-input", stableInstruction: "worker rules", skillPaths: [["/skill"]], tools: ["read"], extraExtensions: [] },
    });
    archiveDiagnostics([{ id: "w1", inboxId: "i", task: "visible task", model: "test/model", status: "success", startedAt: "2026-09-07T00:00:00.000Z", timeline: [{ id: "a", type: "assistant", ts: "2026-09-07T00:00:01.000Z", text: "visible" }] }]);
    const doc = JSON.parse(readFileSync(join(root, "batch-test123.json"), "utf8"));
    assert.equal(doc.version, 1);
    assert.equal(doc.workers[0].timeline[0].text, "visible");
    assert.equal(doc.systemPrompt.kind, "reconstructable-input");
    clearDiagnosticsContext();
  });
});
