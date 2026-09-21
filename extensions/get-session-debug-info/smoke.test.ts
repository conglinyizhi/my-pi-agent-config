// get-session-debug-info 冒烟测试：node --test extensions/get-session-debug-info/smoke.test.ts
//
// 不 spawn 真剪贴板工具：copy 是注入的假实现，断言的是「展示的文本与复制的文本同源」
// 以及三种复制结局各自怎么报。真机剪贴板路径由 lib/clipboard.test.ts 覆盖。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OSC52_TOOL, type ClipboardResult } from "../../lib/clipboard.ts";
import { createDebugInfoHandler, debugInfoLines, displayWidth, padRight, type DebugInfoSource } from "./index.ts";

/** 与 index.ts 的标签列宽度一致；那边改了这个也要改 */
const LABEL_WIDTH = 10;

const SRC: DebugInfoSource = {
  cwd: "/home/dev/project",
  sessionManager: {
    getSessionId: () => "01a0bcdb-1bde-7690-98a5-30dbfbf0d8f7",
    getSessionFile: () => "/home/dev/.pi/agent/sessions/--home-dev-project--/2026-09-20T03-27-51.jsonl",
  },
};

function fakeCtx(overrides: { agree?: boolean; hasUI?: boolean } = {}) {
  const notices: { message: string; level: string }[] = [];
  const statuses: (string | undefined)[] = [];
  const confirms: { title: string; message: string }[] = [];
  const ctx = {
    cwd: SRC.cwd,
    sessionManager: SRC.sessionManager,
    hasUI: overrides.hasUI ?? true,
    ui: {
      confirm: async (title: string, message: string) => {
        confirms.push({ title, message });
        return overrides.agree ?? true;
      },
      notify: (message: string, level: string) => notices.push({ message, level }),
      setStatus: (_id: string, text: string | undefined) => statuses.push(text),
    },
  };
  return { ctx, notices, statuses, confirms };
}

const OK_LOCAL: ClipboardResult = {
  ok: true,
  tool: "wl-copy",
  attempts: [{ tool: "wl-copy", ok: true, code: 0, signal: null }],
  osc52: false,
};

const OK_OSC52: ClipboardResult = { ok: true, tool: OSC52_TOOL, attempts: [], osc52: true };

const ALL_FAILED: ClipboardResult = {
  ok: false,
  tool: null,
  osc52: false,
  attempts: [{ tool: "wl-copy", ok: false, code: null, signal: "SIGKILL", reason: "超时 5000ms 未退出" }],
};

describe("debugInfoLines", () => {
  it("三行：会话 ID / 会话文件 / 当前路径", () => {
    const lines = debugInfoLines(SRC);
    assert.equal(lines.length, 3);
    assert.ok(lines[0].includes("01a0bcdb-1bde-7690-98a5-30dbfbf0d8f7"));
    assert.ok(lines[1].includes("2026-09-20T03-27-51.jsonl"));
    assert.ok(lines[2].includes("/home/dev/project"));
  });

  it("取不到会话信息时写「拿不到」，不留下空白", () => {
    const lines = debugInfoLines({ cwd: "/tmp" });
    assert.ok(lines[0].includes("(拿不到)"));
    assert.ok(lines[1].includes("(拿不到)"));
    assert.ok(lines[2].includes("/tmp"));
  });

  it("标签列对齐：中英混排下值从同一显示列开", () => {
    // 量的是显示列，不是字符下标：CJK 在字符串里算 1 个字符、屏幕上占 2 列，
    // 而填充是按显示宽度做的，拿 indexOf 去断言会差一截
    const lines = debugInfoLines(SRC);
    const markers = ["01a0", "/home/dev/.pi", "/home/dev/project"];
    const valueColumns = lines.map((line, i) => displayWidth(line.slice(0, line.indexOf(markers[i]))));
    assert.deepEqual(valueColumns, [LABEL_WIDTH, LABEL_WIDTH, LABEL_WIDTH], `值没对齐：${JSON.stringify(lines)}`);
  });

  it("padRight 按显示宽度补，CJK 算两列", () => {
    assert.equal(displayWidth("会话文件"), 8);
    assert.equal(displayWidth("会话 ID"), 7); // 会(2) 话(2) 空格(1) I(1) D(1)
    assert.equal(padRight("会话文件", 10), "会话文件  ");
    assert.equal(padRight("会话 ID", 10), "会话 ID   ");
  });
});

describe("命令流程", () => {
  it("取消：不复制、不提示", async () => {
    const { ctx, notices, confirms } = fakeCtx({ agree: false });
    let copied = 0;
    await createDebugInfoHandler({ copy: async () => (copied++, OK_LOCAL) })("", ctx as never);
    assert.equal(copied, 0);
    assert.equal(notices.length, 0);
    assert.equal(confirms.length, 1, "取消也要先看到将复制的文本");
    assert.ok(confirms[0].message.includes("/home/dev/project"));
  });

  it("确认后复制：复制的内容与确认框里展示的完全相同", async () => {
    const { ctx, notices } = fakeCtx();
    let copiedText = "";
    await createDebugInfoHandler({
      copy: async (text) => {
        copiedText = text;
        return OK_LOCAL;
      },
    })("", ctx as never);
    assert.equal(copiedText, debugInfoLines(SRC).join("\n"));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "info");
    assert.ok(notices[0].message.includes("wl-copy"));
  });

  it("OSC 52 兜底：报 warning 并附上原文，不能只说「已复制」", async () => {
    const { ctx, notices } = fakeCtx();
    await createDebugInfoHandler({ copy: async () => OK_OSC52 })("", ctx as never);
    assert.equal(notices[0].level, "warning");
    assert.equal(notices[0].message.includes("已复制到剪贴板"), false);
    assert.ok(notices[0].message.includes("会话文件"), "没真写进去时要把原文附上，便于手动复制");
  });

  it("全部失败：报 warning、带失败原因、也附原文", async () => {
    const { ctx, notices } = fakeCtx();
    await createDebugInfoHandler({ copy: async () => ALL_FAILED })("", ctx as never);
    assert.equal(notices[0].level, "warning");
    assert.ok(notices[0].message.includes("超时 5000ms 未退出"));
    assert.ok(notices[0].message.includes("/home/dev/project"));
  });

  it("没有 UI 就什么都不做（静默复制不算达成目的）", async () => {
    const { ctx, confirms, notices } = fakeCtx({ hasUI: false });
    let copied = 0;
    await createDebugInfoHandler({ copy: async () => (copied++, OK_LOCAL) })("", ctx as never);
    assert.equal(copied, 0);
    assert.equal(confirms.length, 0);
    assert.equal(notices.length, 0);
  });
});
