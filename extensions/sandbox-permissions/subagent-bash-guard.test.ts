// subagent-bash-guard.test.ts — worker bash 的网络档判定
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/subagent-bash-guard.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { networkEnvForCommand } from "./subagent-bash-guard.ts";
import { commandDigest } from "../../lib/subagent-capability.ts";

describe("worker bash 的网络档", () => {
  it("已获批 network 的精确命令带网", () => {
    const command = "curl https://example.com";
    const grants = new Set([`network:${commandDigest(command)}`]);
    assert.equal(networkEnvForCommand(command, grants), "allow");
  });

  it("近似命令不会搭上同一条批准", () => {
    const grants = new Set([`network:${commandDigest("curl https://example.com")}`]);
    assert.equal(networkEnvForCommand("curl https://example.com/x", grants), "block");
    assert.equal(networkEnvForCommand("echo hi", new Set()), "block");
  });

  it("command 能力（非 network）的 grant 不给网", () => {
    const command = "rm -rf /tmp/x";
    const grants = new Set([`command:${commandDigest(command)}`]);
    assert.equal(networkEnvForCommand(command, grants), "block");
  });
});
