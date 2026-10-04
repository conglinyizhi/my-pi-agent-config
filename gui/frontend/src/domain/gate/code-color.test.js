// 跑法：node --test gui/frontend/src/domain/gate/code-color.test.js
// 这里只测纯函数（拼 HTML 与裁剪）；shiki 那层是异步适配，另有运行期探针

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipTokens, composeCodeHtml } from "./code-color.js";

const text = 'const a = 1; // 注释';

describe("拼 HTML", () => {
  it("没 token 没 mark 时原样转义输出", () => {
    assert.equal(composeCodeHtml("a < b", [], []), "a &lt; b");
  });

  it("token 上色，代码一个字符不少", () => {
    const tokens = [{ s: 0, e: 5, color: "#F97583" }, { s: 5, e: text.length, color: "#E1E4E8" }];
    const html = composeCodeHtml(text, tokens, []);
    assert.equal(html.replace(/<[^>]+>/g, ""), "const a = 1; // 注释");
    assert.ok(html.includes('style="color:#F97583">const<'));
  });

  it("标记压在颜色上：两者都保留", () => {
    const tokens = [{ s: 0, e: text.length, color: "#E1E4E8" }];
    const marks = [{ s: 10, e: 11, t: "数字", n: "r1" }];
    const html = composeCodeHtml(text, tokens, marks);
    assert.equal(html.replace(/<[^>]+>/g, ""), text);
    assert.ok(html.includes("<mark class=\"h\" data-tip=\"数字\">"));
    assert.ok(html.includes("<span style=\"color:#E1E4E8\">1</span>"));
  });

  it("赋值与变量标记用各自的类名（含解析不了的灰档）", () => {
    const marks = [
      { s: 6, e: 7, t: "解析出来了", n: "env", kind: "env", known: true },
      { s: 10, e: 11, t: "解析不了", n: "var", kind: "var", known: false },
    ];
    const html = composeCodeHtml(text, [], marks);
    assert.ok(html.includes('class="e"'), html);
    assert.ok(html.includes('class="v v-u"'), html);
  });

  it("提示文本里的引号与尖括号被转义，不会破属性", () => {
    const html = composeCodeHtml("x", [], [{ s: 0, e: 1, t: '坏 "<b>"', n: "r" }]);
    assert.ok(html.includes("&quot;"), html);
    assert.ok(html.includes("&lt;b&gt;"), html);
  });

  it("越界与空区间丢掉，不抛错", () => {
    const html = composeCodeHtml(text, [{ s: -5, e: 3, color: "#fff" }, { s: 4, e: 4, color: "#fff" }], []);
    assert.equal(html.replace(/<[^>]+>/g, ""), text);
  });

  it("空文本给空串", () => {
    assert.equal(composeCodeHtml("", [{ s: 0, e: 1, color: "#fff" }], []), "");
  });
});

describe("裁剪 token", () => {
  it("按区间裁剪并平移，顺带丢掉不沾边的", () => {
    const tokens = [{ s: 0, e: 10, color: "#a" }, { s: 20, e: 30, color: "#b" }];
    assert.deepEqual(clipTokens(tokens, 4, 26), [
      { s: 0, e: 6, color: "#a" },
      { s: 16, e: 22, color: "#b" },
    ]);
  });
});
