// subagent-bash-guard.test.ts — worker bash 的网络档判定
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/subagent-bash-guard.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoApproveCommandByReview, networkEnvForCommand } from "./subagent-bash-guard.ts";
import { commandDigest } from "../../lib/subagent-capability.ts";

describe("worker 命令风险的自动放行判据", () => {
  it("判 safe 且档位 auto（预审说放行）就自动放行", async () => {
    const approved = await autoApproveCommandByReview({
      commandRisk: true,
      networkRisk: false,
      preReview: async () => ({ autoApproved: true }),
    });
    assert.equal(approved, true);
  });

  it("预审说要人看就不放行", async () => {
    const approved = await autoApproveCommandByReview({
      commandRisk: true,
      networkRisk: false,
      preReview: async () => ({ autoApproved: false }),
    });
    assert.equal(approved, false);
  });

  it("网络档不自动放行：外网暴露不该由模型单独拍板", async () => {
    let asked = false;
    const approved = await autoApproveCommandByReview({
      commandRisk: true,
      networkRisk: true,
      preReview: async () => {
        asked = true;
        return { autoApproved: true };
      },
    });
    assert.equal(approved, false);
    assert.equal(asked, false, "网络档连预审都不必跑");
  });

  it("命令本来就被规则放行时不走这条路", async () => {
    const approved = await autoApproveCommandByReview({
      commandRisk: false,
      networkRisk: false,
      preReview: async () => ({ autoApproved: true }),
    });
    assert.equal(approved, false);
  });

  it("预审自己出错时拿不准就问人", async () => {
    const approved = await autoApproveCommandByReview({
      commandRisk: true,
      networkRisk: false,
      preReview: async () => {
        throw new Error("分类模型超时");
      },
    });
    assert.equal(approved, false);
  });
});

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
