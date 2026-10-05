// 跑法：node --test src/domain/gate/script-audit.test.js
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { digestLine, effectSectionsOf, isScriptAudit, scriptAuditTitle } from "./script-audit.js";

describe("脚本事前审核的呈现", () => {
  it("按 subject 认领，别把普通命令审计当脚本", () => {
    assert.equal(isScriptAudit({ subject: "script" }), true);
    assert.equal(isScriptAudit({ kind: "audit" }), false);
    assert.equal(isScriptAudit(null), false);
    assert.ok(scriptAuditTitle().includes("run_code"));
  });

  it("分区按有内容才给，顺序固定", () => {
    const sections = effectSectionsOf({
      tools: ["bash", "read"],
      paths: ["/etc/hostname"],
      commands: ["ls -l"],
      opaque: ["3:1 bash 的参数里有非字面量"],
      digestShort: "0123456789ab",
    });
    // commands 那一区已删：长命令不换行不着色，读不出东西，改在 shell 芯片弹窗里看
    assert.deepEqual(sections.map((s) => s.key), ["tools", "paths", "opaque"]);
    assert.deepEqual(sections[0].items, ["bash", "read"]);
    assert.deepEqual(sections[2].items, ['"ls -l"']);
    assert.equal(sections[3].warn, true);
    assert.equal(sections[0].warn, false);
  });

  it("干跑预演排在字面量之前，没跑成的时候要标出来", () => {
    const sections = effectSectionsOf({
      dryRunCalls: ["read×2", "bash"],
      dryRunStatus: "timeout",
      tools: ["bash"],
    });
    assert.equal(sections[0].key, "dryrun");
    assert.deepEqual(sections[0].items, ["read×2", "bash"]);
    assert.equal(sections[0].warn, true, "预演超时要标黄");
    assert.match(sections[0].label, /可能不全/);
    assert.equal(sections[1].key, "tools");
  });

  it("空字段不产生空分区", () => {
    assert.deepEqual(effectSectionsOf({ tools: [], paths: [] }), []);
    assert.deepEqual(effectSectionsOf(null), []);
    assert.deepEqual(effectSectionsOf({ tools: ["", "  "] }), []);
  });

  it("语法问题单独一档，且标成要留意的", () => {
    const sections = effectSectionsOf({ parseError: "2:5 ')' expected" });
    assert.equal(sections.length, 1);
    assert.equal(sections[0].warn, true);
    assert.match(sections[0].items[0], /expected/);
  });

  it("条目过多时截断并说明还有多少", () => {
    const many = Array.from({ length: 20 }, (_, index) => `/tmp/f${index}`);
    const [section] = effectSectionsOf({ paths: many });
    assert.equal(section.items.length, 13);
    assert.match(section.items[12], /还有 8 条/);
  });

  it("摘要行带短摘要，没有就不显示", () => {
    assert.match(digestLine({ digestShort: "abcdef123456" }), /abcdef123456/);
    assert.equal(digestLine({}), "");
    assert.equal(digestLine(null), "");
  });
});
