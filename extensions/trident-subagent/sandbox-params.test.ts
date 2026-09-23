// sandbox-params.test.ts — 派工沙箱参数校验单测
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/sandbox-params.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planSubagentSandbox, type SandboxPlanDeps } from "./sandbox-params.ts";

const okDir: SandboxPlanDeps = { isDirectory: (p: string) => p === "/work/wt" };
const noDir: SandboxPlanDeps = { isDirectory: () => false };

function plan(params: Parameters<typeof planSubagentSandbox>[0], deps = okDir) {
  return planSubagentSandbox(params, deps);
}

describe("planSubagentSandbox", () => {
  it("都不传 → readonly（安全默认）", () => {
    const r = plan({});
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.plan, { profile: "readonly", sandboxDir: undefined, readonly: true });
  });

  it("只给存在的 sandbox_dir → worktree 且非只读", () => {
    const r = plan({ sandbox_dir: "/work/wt" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.plan, { profile: "worktree", sandboxDir: "/work/wt", readonly: false });
  });

  it("worktree 缺 sandbox_dir → 拒绝", () => {
    const r = plan({ sandbox_profile: "worktree" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, "missing_sandbox_dir");
  });

  it("sandbox_dir + readonly:true → 拒绝（只读会赢，目录用不上）", () => {
    const r = plan({ sandbox_dir: "/work/wt", readonly: true });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, "conflicting_sandbox_scope");
    assert.match(!r.ok ? r.text : "", /\/work\/wt/);
  });

  it("sandbox_dir + sandbox_profile=readonly → 同样拒绝", () => {
    const r = plan({ sandbox_dir: "/work/wt", sandbox_profile: "readonly" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, "conflicting_sandbox_scope");
  });

  it("sandbox_dir 不存在 → 拒绝（不静默退化成只有 /tmp 可写）", () => {
    const r = plan({ sandbox_dir: "/work/missing" }, noDir);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, "sandbox_dir_not_found");
    assert.match(!r.ok ? r.text : "", /\/work\/missing/);
  });

  it("显式 readonly 且没给目录 → 正常只读", () => {
    const r = plan({ sandbox_profile: "readonly" });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.plan.readonly, true);
  });

  it("空白 sandbox_dir 当作没给", () => {
    const r = plan({ sandbox_dir: "   " });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.plan.profile, "readonly");
  });
});
