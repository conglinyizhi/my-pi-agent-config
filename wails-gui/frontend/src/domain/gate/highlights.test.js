import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findHighlights, isPathCovered, pathTrustState, renderHighlightedCommand } from "./highlights.js";

describe("Gate command highlights", () => {
  it("finds repeated matches and merges adjacent matches from the same rule", () => {
    const command = "sudo rm -rf tmp && rm -rf cache";
    const highlights = findHighlights(command, [{ name: "rm", tip: "删除", matched: ["rm", "-rf"] }]);
    assert.deepEqual(highlights.map(({ s, e, n }) => ({ s, e, n })), [
      { s: 5, e: 11, n: "rm" },
      { s: 19, e: 25, n: "rm" },
    ]);
  });

  it("keeps adjacent matches from distinct rules separate", () => {
    const highlights = findHighlights("sudo rm", [
      { name: "sudo", tip: "提权", matched: ["sudo"] },
      { name: "rm", tip: "删除", matched: ["rm"] },
    ]);
    assert.equal(highlights.length, 2);
  });

  it("escapes command text and tooltip attributes when rendering HTML", () => {
    const command = 'echo "<tag>&"';
    const highlights = findHighlights(command, [{ name: "tag", tip: 'say "no" & stop', matched: ["<tag>"] }]);
    assert.equal(
      renderHighlightedCommand(command, highlights),
      'echo &quot;<mark class="h" data-i="0" data-tip="say &quot;no&quot; &amp; stop">&lt;tag&gt;</mark>&amp;&quot;',
    );
  });

  it("reports the most specific available trust state", () => {
    assert.equal(isPathCovered("/repo/a", ["/repo"]), true);
    assert.equal(isPathCovered("/repository", ["/repo"]), false);
    assert.equal(pathTrustState("/repo/a", { persistentRoots: [], sessionTrustedRoots: ["/repo"], sessionWriteRoots: [] }), "本 session 信任");
    assert.equal(pathTrustState("/repo/a", { persistentRoots: ["/repo"], sessionTrustedRoots: ["/repo"], sessionWriteRoots: ["/repo"] }), "长期信任");
  });
});
