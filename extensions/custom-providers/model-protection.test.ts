import assert from "node:assert";
import { describe, it } from "node:test";
import { parseProvidersToml } from "./loader.ts";
import { isProtected, mergeOnlineModelIds, preserveProtectedUpdate } from "./model-protection.ts";
import type { ModelOverride } from "./types.ts";

describe("model protection", () => {
  it("parses supported do_not actions and ignores unknown actions", () => {
    const result = parseProvidersToml(`
[[providers]]
id = "p"
base_url = "https://example.com"
models = [{ id = "hidden", do_not = ["remove", "update", "edit", "typo"] }]
`);
    const model = (result.providers?.[0].models as ModelOverride[])[0];
    assert.deepStrictEqual(model.do_not, ["remove", "update", "edit"]);
  });

  it("keeps remove-protected models missing from the online list", () => {
    const existing: ModelOverride[] = [
      { id: "visible" },
      { id: "hidden", do_not: ["remove"] },
    ];
    assert.deepStrictEqual(mergeOnlineModelIds(["visible", "new"], existing), ["visible", "new", "hidden"]);
  });

  it("freezes an update-protected model's local override", () => {
    const existing: ModelOverride = {
      id: "hidden",
      name: "Private model",
      contextWindow: 12345,
      do_not: ["update"],
    };
    const candidate: ModelOverride = {
      id: "hidden",
      name: "Online name",
      contextWindow: 99999,
    };
    assert.deepStrictEqual(preserveProtectedUpdate(candidate, existing), existing);
    assert.strictEqual(isProtected(existing, "edit"), false);
  });
});
