// lib/sandbox-check.test.ts — 沙盒命令判定层的敏感路径处置（block / ask 两条路）
//
// 跑法：node --experimental-strip-types lib/sandbox-check.test.ts
//
// 背景：敏感路径黑名单过去在所有调用方都是硬拒。sandbox-allow 是唯一有「问人」出口的
// 通道（升权工具存在的意义就是让人对越界但正当的操作拍板），所以它声明 ask：
// 命中项交给审批窗，但绝不静默放行。普通 bash 与 worker bash 仍是 block（没有同意出口）。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCommand } from "./sandbox-check.ts";

describe("checkCommand：敏感路径黑名单", () => {
  it("默认 block：直接拒，且不带可放行的命中项", () => {
    const result = checkCommand("cat /work/project/.env", { cwd: "/work/project" });
    assert.equal(result.allow, false);
    assert.match(result.reason ?? "", /敏感路径黑名单/);
    assert.equal(result.sensitive, undefined);
  });

  it("ask：不在判定层拒，把命中项交给上层弹审批", () => {
    const command = "cat /work/project/.env && ls -la";
    const result = checkCommand(command, { cwd: "/work/project", sensitivePaths: "ask" });
    assert.equal(result.allow, false);
    assert.deepEqual(result.sensitive, [{ pattern: ".env", token: ".env" }]);
    // 不并进 rules：rules 是「命令写法有风险」的语义，会连带影响目录长期授权
    assert.equal(result.rules, undefined);
    // 命中片段必须能在命令里原样找到（审批窗高亮靠它定位）
    for (const hit of result.sensitive ?? []) assert.ok(command.includes(hit.token), `${hit.token} 不在命令里`);
  });

  it("ask 不影响不含敏感路径的普通命令", () => {
    const result = checkCommand("ls -la", { cwd: "/work/project", sensitivePaths: "ask" });
    assert.equal(result.allow, true);
  });

  it("ask 只放敏感路径那一关：危险规则照旧走规则链", () => {
    const result = checkCommand("sudo rm -rf /work/project/out", { cwd: "/work/project", sensitivePaths: "ask" });
    assert.equal(result.allow, false);
    assert.ok((result.rules?.length ?? 0) > 0, "sudo/rm 这类规则仍要命中");
  });
});
