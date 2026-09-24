// render.test.ts — sandbox-allow 的调用行/结果区展示（纯字符串组装）
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/render.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COLLAPSED_TAIL_LINES,
  EXPANDED_MAX_LINES,
  describePermission,
  formatCallText,
  formatResultFooter,
  formatResultText,
  type RenderTheme,
} from "./render.ts";

/** 无着色主题：断言文本时可读 */
const theme: RenderTheme = { fg: (_c, text) => text, bold: (text) => text };

describe("describePermission", () => {
  it("write-paths 报可写根数量，full-access 报影响面", () => {
    assert.equal(describePermission("write-paths", ["/srv/a", "/srv/b"]), "write-paths（2 个可写根）");
    assert.equal(describePermission("full-access", undefined), "full-access（本次取消文件系统沙箱）");
    assert.equal(describePermission(undefined, undefined), "权限未定");
  });
});

describe("formatCallText", () => {
  it("调用行含权限、时限、内存、命令与理由", () => {
    const text = formatCallText({
      command: "go install ./cmd/tool",
      permission: "write-paths",
      paths: ["/home/u/go"],
      justification: "需要写入 Go 工具缓存",
      timeout: 120,
      memoryMb: 2048,
    }, theme);
    assert.match(text, /sandbox-allow /);
    assert.match(text, /write-paths（1 个可写根）/);
    assert.match(text, /时限 120s/);
    assert.match(text, /内存 2048MB/);
    assert.match(text, /\$ go install \.\/cmd\/tool/);
    assert.match(text, /理由：需要写入 Go 工具缓存/);
  });

  it("没有时限/内存时不硬塞字段", () => {
    const text = formatCallText({ command: "echo hi", permission: "write-paths", paths: ["/tmp/x"] }, theme);
    assert.doesNotMatch(text, /时限/);
    assert.doesNotMatch(text, /内存/);
    assert.doesNotMatch(text, /理由/);
  });

  it("长命令与长理由收成单行截断，不把调用行撑爆", () => {
    const text = formatCallText({
      command: `echo ${"字".repeat(200)} && echo tail`,
      permission: "write-paths",
      paths: ["/tmp/x"],
      justification: "理".repeat(200),
    }, theme);
    const lines = text.split("\n");
    assert.equal(lines.length, 3);
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    for (const line of lines.slice(1)) {
      const plain = stripAnsi(line);
      assert.ok(plain.length <= 110, `行太长：${plain.length}`);
      assert.match(plain, /…$/);
    }
  });
});

describe("formatResultFooter", () => {
  it("退出码 + 本次权限 + 可写根 + 内存", () => {
    const footer = formatResultFooter({ exitCode: 0, permission: "write-paths", writePaths: ["/srv/a"], timeout: 60 }, theme);
    assert.match(footer, /退出码 0/);
    assert.match(footer, /额外可写：\/srv\/a/);
    assert.match(footer, /时限 60s/);
    assert.match(footer, /内存默认 1024MB/);
  });

  it("被截断时给出全量输出路径（否则长输出只剩截断那截）", () => {
    const footer = formatResultFooter({ exitCode: 1, permission: "full-access", fullOutputPath: "/tmp/x.log" }, theme);
    assert.match(footer, /退出码 1/);
    assert.match(footer, /full-access/);
    assert.match(footer, /全量输出：\/tmp\/x\.log/);
  });
});

describe("formatResultText", () => {
  const many = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n");

  it("折叠态只给尾巴，并写明共多少行", () => {
    const text = formatResultText(many, { expanded: false, footer: "F" }, theme);
    const lines = text.split("\n");
    assert.ok(lines.includes(`line-100`), "最新一行要在");
    assert.ok(!lines.includes("line-1"), "最早的行折叠掉");
    assert.ok(lines.includes(`line-${100 - COLLAPSED_TAIL_LINES + 1}`));
    assert.match(text, /共 100 行，此处为最后 15 行/);
    assert.match(text, /展开看更早的行/);
    assert.ok(text.endsWith("F"), "页脚在最后");
  });

  it("展开态给到上限，超出的提示去看全量输出", () => {
    const huge = Array.from({ length: EXPANDED_MAX_LINES + 50 }, (_, i) => `L${i}`).join("\n");
    const text = formatResultText(huge, { expanded: true, footer: "F" }, theme);
    assert.match(text, new RegExp(`共 ${EXPANDED_MAX_LINES + 50} 行，此处为最后 ${EXPANDED_MAX_LINES} 行`));
    assert.match(text, /已到展开上限，剩余部分看全量输出/);
  });

  it("输出短于窗口时没有省略提示", () => {
    const text = formatResultText("a\nb", { expanded: false, footer: "F" }, theme);
    assert.equal(text, "a\nb\nF");
  });

  it("空输出只留页脚", () => {
    assert.equal(formatResultText("", { expanded: false, footer: "F" }, theme), "F");
  });
});
