import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VAR_RENDER_LIMIT, mergeVarHighlights, varRenderHighlights, varRenderRows } from "./var-renders.js";
import { findHighlights, mergeEnvHighlights, renderHighlightedCommand } from "./highlights.js";
import { envNoteHighlights } from "./env-notes.js";
import { browserFixtures } from "../../fixtures/browser.js";

describe("varRenders → 高亮条目", () => {
  it("在命令里定位 target，解析出来的标蓝、悬停文案带值", () => {
    const command = "P=/usr/bin/jq && $P -n 1";
    const renders = [{ name: "P", value: "/usr/bin/jq", source: "assignment", target: "$P", kind: "Exec", known: true }];
    const highlights = varRenderHighlights(command, renders);
    assert.equal(highlights.length, 1);
    assert.deepEqual([highlights[0].s, highlights[0].e], [17, 19]);
    assert.equal(command.slice(highlights[0].s, highlights[0].e), "$P");
    assert.equal(highlights[0].tone, "var");
    assert.match(highlights[0].t, /P = \/usr\/bin\/jq/);
    assert.match(highlights[0].t, /命令内赋值/);
  });

  it("同一个 target 在命令里出现多次时每一处都标", () => {
    const command = "echo $OUT && cat $OUT";
    const renders = [{ name: "OUT", value: "/tmp/o", source: "env", target: "$OUT", kind: "Exec", known: true }];
    const highlights = varRenderHighlights(command, renders);
    assert.deepEqual(highlights.map((h) => [h.s, h.e]), [[5, 9], [17, 21]]);
  });

  it("known:false 的标灰，文案是原因而不是值", () => {
    const command = "SRC=$(pwd) cp $SRC /tmp";
    const renders = [{ name: "SRC", target: "$(pwd)", kind: "Exec", known: false, reason: "值里含命令替换 $(...)，无法静态解析" }];
    const highlights = varRenderHighlights(command, renders);
    assert.equal(highlights.length, 1);
    assert.equal(highlights[0].tone, "var-unknown");
    assert.equal(command.slice(highlights[0].s, highlights[0].e), "$(pwd)");
    assert.match(highlights[0].t, /SRC：解析不了/);
    assert.match(highlights[0].t, /命令替换/);
    assert.doesNotMatch(highlights[0].t, /undefined/);
  });

  it("标识符形态的 target 不做词内命中", () => {
    const p = { name: "P", value: "/usr/bin/jq", source: "env", target: "$P", kind: "Exec", known: true };
    assert.deepEqual(varRenderHighlights("echo $PATH", [p]), []); // $P 不落在 $PATH 里
    assert.equal(varRenderHighlights("echo $P", [p]).length, 1);
    const path = { name: "PATH", value: "/bin", source: "env", target: "PATH", kind: "Exec", known: true };
    assert.deepEqual(varRenderHighlights("echo PATH_EXTRA", [path]), []); // PATH 不落在 PATH_EXTRA 里
    assert.equal(varRenderHighlights("echo $PATH", [path])[0].s, 6);
  });

  it("target 找不到、缺失或命令不是字符串时都不画错框", () => {
    assert.deepEqual(varRenderHighlights("ls -la", [{ name: "P", target: "$P", known: false }]), []);
    assert.deepEqual(varRenderHighlights("ls -la", [{ name: "P", known: false }]), []);
    assert.deepEqual(varRenderHighlights("ls -la", null), []);
    assert.deepEqual(varRenderHighlights(null, [{ name: "P", target: "P", known: true, value: "1" }]), []);
  });

  it("条数上限 20，超出只取前 20 条", () => {
    const command = Array.from({ length: 25 }, (_, i) => `$V${i}`).join(" ");
    const renders = Array.from({ length: 25 }, (_, i) => ({
      name: `V${i}`, value: String(i), source: "env", target: `$V${i}`, kind: "Exec", known: true,
    }));
    assert.equal(varRenderRows(renders).length, VAR_RENDER_LIMIT);
    assert.equal(varRenderHighlights(command, renders).length, VAR_RENDER_LIMIT);
  });

  it("同一条 target 重复出现时只留前一条（偏移单调，不重叠）", () => {
    const command = "echo $OUT";
    const renders = [
      { name: "OUT", value: "/a", source: "env", target: "$OUT", kind: "Exec", known: true },
      { name: "OUT", value: "/b", source: "env", target: "$OUT", kind: "Exec", known: true },
    ];
    const highlights = varRenderHighlights(command, renders);
    assert.equal(highlights.length, 1);
    assert.match(highlights[0].t, /\/a/);
  });
});

describe("varRenders → 变量表行", () => {
  it("带上名字、值、来源与 kind；解析不了的带原因", () => {
    const rows = varRenderRows([
      { name: "P", value: "/usr/bin/jq", source: "assignment", target: "$P", kind: "Exec", known: true },
      { name: "SRC", target: "$(pwd)", kind: "Exec", known: false, reason: "值里含命令替换 $(...)，无法静态解析" },
    ]);
    assert.deepEqual(rows.map((r) => [r.name, r.value, r.known, r.sourceLabel]), [
      ["P", "/usr/bin/jq", true, "命令内赋值"],
      ["SRC", "", false, "命令内赋值"],
    ]);
    assert.match(rows[1].reason, /命令替换/);
    assert.equal(rows[0].kind, "Exec");
    assert.notEqual(rows[0].key, rows[1].key);
  });

  it("source=env 标成环境变量；空值与非法输入都容错", () => {
    const rows = varRenderRows([
      { name: "HOME", value: "/root", source: "env", target: "$HOME", kind: "Exec", known: true },
      { name: "EMPTY", value: "", source: "env", target: "$EMPTY", kind: "Exec", known: true },
    ]);
    assert.equal(rows[0].sourceLabel, "环境变量");
    assert.equal(rows[1].known, true);
    assert.equal(rows[1].value, "");
    assert.deepEqual(varRenderRows(null), []);
    assert.deepEqual(varRenderRows([null, 7, "x"]), []);
  });

  it("reason 缺失时也给一句可展示的文案", () => {
    const highlights = varRenderHighlights("echo $A", [{ name: "A", target: "$A", known: false }]);
    assert.match(highlights[0].t, /原因不明/);
  });
});

describe("三类高亮共存", () => {
  const renders = [
    { name: "OUT", value: "/tmp/out", source: "assignment", target: "$OUT", kind: "Exec", known: true },
    { name: "HOME", value: "/home/u", source: "env", target: "$HOME", kind: "Exec", known: true },
    { name: "SRC", target: "$(pwd)", kind: "Exec", known: false, reason: "值里含命令替换 $(...)，无法静态解析" },
  ];

  it("赋值那一格由 envNotes 占着时，变量高亮让位（绿框不被蓝框盖）", () => {
    const command = 'OUT=$HOME/out && echo "$OUT"';
    const notes = [{ name: "OUT", raw: "OUT=$HOME/out", start: 0, end: 13, value: "/home/u/out" }];
    const base = mergeEnvHighlights(envNoteHighlights(command, notes), []);
    const merged = mergeVarHighlights(varRenderHighlights(command, renders), base);
    // $HOME 落在 envNotes 的赋值里，被压掉；末尾 "$OUT" 那一处保留
    assert.deepEqual(merged.map((h) => h.tone), ["env", "var"]);
    assert.equal(command.slice(merged[0].s, merged[0].e), "OUT=$HOME/out");
    assert.equal(command.slice(merged[1].s, merged[1].e), "$OUT");
  });

  it("互不重叠时三类都在，且按偏移排序", () => {
    const command = 'KEEP=1 && rm -rf "$OUT"';
    const notes = [{ name: "KEEP", raw: "KEEP=1", start: 0, end: 6, value: "1" }];
    const rules = [{ s: 10, e: 16, t: "递归删除会永久移除路径内容", n: "rm-recursive" }];
    const base = mergeEnvHighlights(envNoteHighlights(command, notes), rules);
    const merged = mergeVarHighlights(varRenderHighlights(command, renders), base);
    assert.deepEqual(merged.map((h) => h.tone ?? "rule"), ["env", "rule", "var"]);
    assert.equal(merged.map((h) => command.slice(h.s, h.e)).join("|"), 'KEEP=1|rm -rf|$OUT');
  });

  it("渲染出第三套类名：mark.v / mark.v-u，规则仍是 mark.h", () => {
    const command = "OUT=/tmp/o && rm -rf $OUT";
    const base = mergeEnvHighlights([], [{ s: 14, e: 16, t: "删", n: "rm-recursive" }]);
    const merged = mergeVarHighlights(varRenderHighlights(command, renders), base);
    const html = renderHighlightedCommand(command, merged);
    assert.match(html, /<mark class="v" data-i="\d+" data-tip="[^"]*OUT = \/tmp\/o/);
    assert.match(html, /<mark class="h" data-i="\d+" data-tip="删"/);
    assert.match(renderHighlightedCommand("x $(pwd)", varRenderHighlights("x $(pwd)", renders)), /class="v v-u"/);
  });

  it("没有 varRenders 时渲染结果与以前一致（只有规则）", () => {
    const rules = [{ s: 0, e: 4, t: "提权", n: "sudo" }];
    const html = renderHighlightedCommand("sudo ls", mergeVarHighlights(varRenderHighlights("sudo ls", null), rules));
    assert.equal(html, '<mark class="h" data-i="0" data-tip="提权">sudo</mark> ls');
  });

  // 浏览器壳 fixture 的数据走一遍 GateView / GateCommandPreview 用的同一条通路：
  // fixture 改了、或组件拼接方式改了，这里会先红
  it("浏览器 fixture 的 gate 数据能同时渲染出规则、赋值与变量三类标记", () => {
    const { command, rules, envNotes, varRenders } = browserFixtures.gate;
    const merged = mergeVarHighlights(
      varRenderHighlights(command, varRenders),
      mergeEnvHighlights(envNoteHighlights(command, envNotes), findHighlights(command, rules)),
    );
    const html = renderHighlightedCommand(command, merged);
    assert.match(html, /<mark class="h"/);
    assert.match(html, /<mark class="e"/);
    assert.match(html, /<mark class="e e-u"/);
    assert.match(html, /<mark class="v"/);
    // 被 envNotes 的绿框盖住的 $HOME 不再另画蓝框
    assert.equal(merged.filter((h) => h.tone === "var").length, 1);
    const rows = varRenderRows(varRenders);
    assert.deepEqual(rows.map((r) => [r.name, r.known]), [["SRC", false], ["HOME", true], ["OUT", true]]);
  });
});
