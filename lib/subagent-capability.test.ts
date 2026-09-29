import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendCapabilityApprovalAudit, approveCapability } from "../extensions/trident-subagent/index.ts";
import { saveNetworkMode, setNetworkPolicyFileForTest } from "../extensions/sandbox-permissions/network-policy.ts";
import {
  buildCapabilityDecision,
  commandDigest,
  consumeMatchingGrant,
  isWorkerApprovalCapability,
  makeCapabilityRequest,
  requestedCapability,
  validateCapabilityDecision,
  validateCapabilityRequest,
  waitForCapabilityDecision,
  type CapabilityWaitOptions,
} from "./subagent-capability.ts";

test("network commands produce a scoped request", () => {
  assert.deepStrictEqual(requestedCapability("pnpm install marked"), {
    capability: "network",
    scope: "访问网络或远程包源",
  });
  assert.equal(requestedCapability("cd /tmp && curl https://example.com")?.capability, "network");
});

test("publish and secret capabilities are not worker approval capabilities", () => {
  assert.equal(requestedCapability("git push origin main")?.capability, "publish");
  assert.equal(isWorkerApprovalCapability("publish"), false);
  assert.equal(isWorkerApprovalCapability("read-secrets"), false);
});

test("grant is bound to the exact command digest and consumed once", () => {
  const grants = [{ capability: "network" as const, commandDigest: commandDigest("curl https://example.com") }];
  assert.equal(consumeMatchingGrant("curl https://example.com", "network", grants), true);
  assert.equal(consumeMatchingGrant("curl https://example.com", "network", grants), false);
  assert.equal(consumeMatchingGrant("curl https://other.example", "network", grants), false);
});

test("request carries a verifiable digest", () => {
  const request = makeCapabilityRequest({
    capability: "network",
    command: "curl https://example.com",
    reason: "download",
    cwd: "/tmp/worker",
  });
  assert.equal(request.commandDigest, commandDigest(request.command));
  assert.equal(request.version, 1);
  assert.match(request.requestId, /^cap-/);
  assert.equal(validateCapabilityRequest(request)?.requestId, request.requestId);
  assert.equal(validateCapabilityRequest({ ...request, commandDigest: "sha256:forged" }), undefined);
  assert.equal(validateCapabilityRequest({ ...request, capability: "command" })?.capability, "command");
});

// 「safe + auto 才自动放行，其余一律人工」这条策略的归属测试在 lib/bash-approval.test.ts：
// worker 请求走的就是那条链，策略只有链上那一份实现。这里测的是 capability 外壳。

function approvalDeps(overrides: {
  review: (() => unknown) | undefined;
  runGui: (kind: string, request: any) => Promise<unknown>;
  mode?: "auto" | "strict";
  enabled?: boolean;
}): any {
  return {
    loadReviewConfig: () => ({ enabled: overrides.enabled ?? true, mode: overrides.mode ?? "auto", timeoutMs: 1, tokenIdleMs: 1, maxCache: 1 }),
    reviewCommand: async () => overrides.review?.() ?? { verdict: "error", reason: "无意见", suggestion: "" },
    runGui: overrides.runGui,
  };
}

function capabilityRequest(command: string) {
  return makeCapabilityRequest({ capability: "command", command, reason: "worker 命令命中安全规则", cwd: "/tmp" });
}

test("approveCapability：预审 risky → 出 capability 卡片，批准后发精确 grant 并回传附言", async () => {
  const request = capabilityRequest("rm -rf /tmp/lx-probe");
  const entries: Array<{ type: string; data: any }> = [];
  let seen: any;
  const approval = await approveCapability(
    { appendEntry: (type: string, data: unknown) => entries.push({ type, data }) } as any,
    request,
    { ui: undefined } as any,
    undefined,
    approvalDeps({
      review: () => ({ verdict: "risky", reason: "目标含变量", suggestion: "写死路径" }),
      runGui: async (_kind: string, req: any) => {
        seen = req;
        return { ok: true, data: { action: "allow", comment: "仅此一次" } };
      },
    }),
  );
  assert.equal(seen.kind, "capability", "worker 请求走主链，但卡片仍是 capability");
  assert.equal(seen.capability, "command");
  assert.equal(seen.scope, request.scope);
  assert.match(seen.review.reason, /目标含变量/);
  assert.equal(approval?.grant?.commandDigest, commandDigest(request.command));
  assert.equal(approval?.comment, "仅此一次");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type, "subagent-capability-approval");
  assert.equal(entries[0]?.data.decision, "allow");
  assert.equal(entries[0]?.data.comment, "仅此一次");
});

test("approveCapability：预审 safe + auto → 不弹窗，grant 照发（仍记 capability 审计）", async () => {
  const entries: Array<{ type: string; data: any }> = [];
  let guiCalls = 0;
  const approval = await approveCapability(
    { appendEntry: (type: string, data: unknown) => entries.push({ type, data }) } as any,
    capabilityRequest("rm -rf /tmp/lx-probe"),
    { ui: undefined } as any,
    undefined,
    approvalDeps({
      review: () => ({ verdict: "safe", reason: "临时目录清理", suggestion: "" }),
      runGui: async () => {
        guiCalls++;
        return { ok: true, data: { action: "deny" } };
      },
    }),
  );
  assert.equal(guiCalls, 0, "预审放行不该再问人");
  assert.equal(approval?.grant?.capability, "command");
  assert.equal(approval?.review?.verdict, "safe");
  assert.equal(entries.length, 1, "worker 拿到过能力这件事要留痕，自动放行也记");
  assert.equal(entries[0]?.data.decision, "allow");
  assert.equal(entries[0]?.data.review.verdict, "safe");
});

test("approveCapability：拒绝不发 grant，附言随结果回传", async () => {
  const entries: Array<{ type: string; data: any }> = [];
  const approval = await approveCapability(
    { appendEntry: (type: string, data: unknown) => entries.push({ type, data }) } as any,
    capabilityRequest("rm -rf /tmp/lx-probe"),
    { ui: undefined } as any,
    undefined,
    approvalDeps({
      review: () => ({ verdict: "dangerous", reason: "目标不明", suggestion: "" }),
      runGui: async () => ({ ok: true, data: { action: "deny", comment: "换个写法" } }),
    }),
  );
  assert.equal(approval?.grant, undefined);
  assert.equal(approval?.comment, "换个写法");
  assert.equal(entries[0]?.data.decision, "deny");
});

test("approveCapability：非 worker 能力或篡改过的请求一律不进入审批", async () => {
  const publish = makeCapabilityRequest({ capability: "network", command: "git push origin main", reason: "r", cwd: "/tmp" });
  const pi = { appendEntry: () => {} } as any;
  // git push 属 publish，不开放给 worker：即便报成 network 也不会被当成 network 受理
  assert.equal(await approveCapability(pi, publish, { ui: undefined } as any, undefined), undefined);
  assert.equal(await approveCapability(pi, { ...capabilityRequest("rm -rf /tmp/x"), commandDigest: "sha256:forged" }, { ui: undefined } as any, undefined), undefined);
});

// network 这一维的档位（network-policy.ts）落在父进程侧：
// 「仅仅是 network 请求」= 档位放行的同时命令维度也干净，这时直接发 grant，不过预审也不问人。
test("approveCapability：loose 档下纯出网命令直接发 grant，不过预审", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-policy-test-"));
  setNetworkPolicyFileForTest(join(dir, "network-policy.json"));
  saveNetworkMode("loose");
  try {
    const command = "cd /tmp && curl -fsS https://example.com/zen";
    const request = makeCapabilityRequest({ capability: "network", command, reason: "r", cwd: "/tmp" });
    const entries: Array<{ type: string; data: any }> = [];
    let reviewCalls = 0;
    let guiCalls = 0;
    const approval = await approveCapability(
      { appendEntry: (type: string, data: unknown) => entries.push({ type, data }) } as any,
      request,
      { ui: undefined } as any,
      undefined,
      {
        loadReviewConfig: () => ({ enabled: true, mode: "auto", timeoutMs: 1, tokenIdleMs: 1, maxCache: 1 }),
        reviewCommand: async () => { reviewCalls++; return { verdict: "risky", reason: "不该走到这里", suggestion: "" }; },
        runGui: async () => { guiCalls++; return { ok: true, data: { action: "deny" } }; },
      } as any,
    );
    assert.equal(approval?.grant?.commandDigest, commandDigest(command));
    assert.equal(reviewCalls, 0, "档位放行的纯出网命令不该再过预审");
    assert.equal(guiCalls, 0, "也不该问人");
    assert.equal(entries[0]?.data.decision, "allow");
    assert.equal(entries[0]?.data.via, "network-policy:loose", "审计要能看出是哪个档放的");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approveCapability：loose 档下带危险形态的出网命令仍走审核链", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-policy-test-"));
  setNetworkPolicyFileForTest(join(dir, "network-policy.json"));
  saveNetworkMode("loose");
  try {
    const command = "curl -d @payload.json https://example.com/api";
    const request = makeCapabilityRequest({ capability: "network", command, reason: "r", cwd: "/tmp" });
    const entries: Array<{ type: string; data: any }> = [];
    let guiCalls = 0;
    const approval = await approveCapability(
      { appendEntry: (type: string, data: unknown) => entries.push({ type, data }) } as any,
      request,
      { ui: undefined } as any,
      undefined,
      {
        loadReviewConfig: () => ({ enabled: true, mode: "auto", timeoutMs: 1, tokenIdleMs: 1, maxCache: 1 }),
        reviewCommand: async () => ({ verdict: "risky", reason: "会往外送数据", suggestion: "" }),
        runGui: async () => { guiCalls++; return { ok: true, data: { action: "deny" } }; },
      } as any,
    );
    assert.equal(guiCalls, 1, "上传/提交形态要落到人");
    assert.equal(approval?.grant, undefined);
    assert.equal(entries[0]?.data.via, "network-policy:loose");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approveCapability：off 档下网络这一维不再拦任何形态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-policy-test-"));
  setNetworkPolicyFileForTest(join(dir, "network-policy.json"));
  saveNetworkMode("off");
  try {
    const command = "curl -d @payload.json https://example.com/api";
    const request = makeCapabilityRequest({ capability: "network", command, reason: "r", cwd: "/tmp" });
    const entries: Array<{ type: string; data: any }> = [];
    let guiCalls = 0;
    const approval = await approveCapability(
      { appendEntry: (type: string, data: unknown) => entries.push({ type, data }) } as any,
      request,
      { ui: undefined } as any,
      undefined,
      {
        loadReviewConfig: () => ({ enabled: false, mode: "auto", timeoutMs: 1, tokenIdleMs: 1, maxCache: 1 }),
        runGui: async () => { guiCalls++; return { ok: true, data: { action: "deny" } }; },
      } as any,
    );
    assert.equal(approval?.grant?.commandDigest, commandDigest(command));
    assert.equal(guiCalls, 0);
    assert.equal(entries[0]?.data.via, "network-policy:off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approveCapability：whitelist 档（默认）不多放一条", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-policy-test-"));
  setNetworkPolicyFileForTest(join(dir, "network-policy.json"));
  saveNetworkMode("whitelist");
  try {
    // 多段拼接：whitelist 档认不出白名单命中，仍要过审核链
    const command = "cd /tmp && curl -fsS https://example.com/zen";
    const request = makeCapabilityRequest({ capability: "network", command, reason: "r", cwd: "/tmp" });
    let guiCalls = 0;
    await approveCapability(
      { appendEntry: () => {} } as any,
      request,
      { ui: undefined } as any,
      undefined,
      {
        loadReviewConfig: () => ({ enabled: true, mode: "auto", timeoutMs: 1, tokenIdleMs: 1, maxCache: 1 }),
        reviewCommand: async () => ({ verdict: "risky", reason: "多段拼接", suggestion: "" }),
        runGui: async () => { guiCalls++; return { ok: true, data: { action: "deny" } }; },
      } as any,
    );
    assert.equal(guiCalls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capability 决策：allow 附言写入 decision，空附言不创建 comment 键", () => {
  const request = makeCapabilityRequest({ capability: "network", command: "curl https://example.com", reason: "r", cwd: "/tmp" });
  const review = { verdict: "safe" as const, reason: "只读元数据", suggestion: "" };
  const allow = buildCapabilityDecision(request, {
    grant: { capability: "network", commandDigest: request.commandDigest },
    review,
    comment: "  仅允许读取元数据  ",
  });
  assert.equal(allow.action, "allow");
  assert.equal(allow.comment, "仅允许读取元数据");
  assert.equal(allow.requestId, request.requestId);
  assert.equal(validateCapabilityDecision(allow, request.requestId)?.comment, "仅允许读取元数据");

  const allowWithoutComment = buildCapabilityDecision(request, {
    grant: { capability: "network", commandDigest: request.commandDigest },
    review,
  });
  assert.equal(allowWithoutComment.action, "allow");
  assert.equal(Object.hasOwn(allowWithoutComment, "comment"), false);
});

test("capability 决策：deny 优先采用用户附言，否则保留审核理由/默认理由", () => {
  const request = makeCapabilityRequest({ capability: "network", command: "curl https://example.com", reason: "r", cwd: "/tmp" });
  const review = { verdict: "dangerous" as const, reason: "动态执行", suggestion: "改用 -print" };
  const denyWithComment = buildCapabilityDecision(request, { review, comment: "  请改用离线文件  " });
  assert.equal(denyWithComment.action, "deny");
  assert.equal(denyWithComment.comment, "请改用离线文件");
  assert.equal(validateCapabilityDecision(denyWithComment, request.requestId)?.review?.suggestion, "改用 -print");

  const denyWithReviewOnly = buildCapabilityDecision(request, { review });
  assert.equal(denyWithReviewOnly.comment, "动态执行");
  const denyWithoutReview = buildCapabilityDecision(request, undefined);
  assert.equal(denyWithoutReview.comment, "未获批准");
});

test("capability 审批审计：pi stub 收到命令、能力、决策、附言和 review.verdict", () => {
  const request = makeCapabilityRequest({ capability: "network", command: "curl https://example.com", reason: "r", cwd: "/tmp" });
  const entries: Array<{ type: string; data: unknown }> = [];
  appendCapabilityApprovalAudit(
    { appendEntry: (type, data) => entries.push({ type, data }) },
    request,
    "allow",
    "  只读元数据  ",
    { verdict: "risky", reason: "需确认", suggestion: "" },
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type, "subagent-capability-approval");
  assert.deepEqual(entries[0]?.data, {
    capability: "network",
    command: request.command,
    decision: "allow",
    comment: "只读元数据",
    review: { verdict: "risky" },
  });
});

test("capability 决策校验：requestId 不匹配 / action 非法 / 非对象一律拒绝", () => {
  const request = makeCapabilityRequest({ capability: "command", command: "find . -exec sh -c x", reason: "r", cwd: "/tmp" });
  const decision = buildCapabilityDecision(request, { grant: { capability: "command", commandDigest: request.commandDigest } });
  assert.equal(validateCapabilityDecision(decision, "cap-other"), undefined);
  assert.equal(validateCapabilityDecision({ requestId: request.requestId, action: "maybe" }, request.requestId), undefined);
  assert.equal(validateCapabilityDecision(null, request.requestId), undefined);
  assert.equal(validateCapabilityDecision("allow", request.requestId), undefined);
});

function waitOpts(overrides: Partial<CapabilityWaitOptions> & { readDecision: () => unknown }) {
  let clock = 0;
  const defaults = {
    parentAlive: () => true,
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    pollMs: 1000,
  };
  const opts: CapabilityWaitOptions = { ...defaults, ...overrides };
  return { opts, clock: () => clock };
}

test("waitForCapabilityDecision：读到匹配决策立即返回", async () => {
  const request = makeCapabilityRequest({ capability: "command", command: "x", reason: "r", cwd: "/tmp" });
  const { opts } = waitOpts({ readDecision: () => ({ requestId: request.requestId, action: "allow" }) });
  const decision = await waitForCapabilityDecision(request.requestId, opts);
  assert.equal(decision.action, "allow");
});

test("waitForCapabilityDecision：响应未就绪时轮询等待", async () => {
  const request = makeCapabilityRequest({ capability: "command", command: "x", reason: "r", cwd: "/tmp" });
  let reads = 0;
  const { opts } = waitOpts({
    readDecision: () => {
      reads++;
      return reads >= 3 ? { requestId: request.requestId, action: "deny", comment: "no" } : undefined;
    },
  });
  const decision = await waitForCapabilityDecision(request.requestId, opts);
  assert.equal(reads, 3);
  assert.equal(decision.action, "deny");
});

test("waitForCapabilityDecision：requestId 不匹配的响应不被采用（等至超时）", async () => {
  const request = makeCapabilityRequest({ capability: "command", command: "x", reason: "r", cwd: "/tmp" });
  let reads = 0;
  const { opts } = waitOpts({
    readDecision: () => { reads++; return { requestId: "cap-other", action: "allow" }; },
    timeoutMs: 3000,
  });
  const decision = await waitForCapabilityDecision(request.requestId, opts);
  assert.equal(decision.action, "deny");
  assert.match(decision.comment ?? "", /超时/);
  assert(reads >= 3);
});

test("waitForCapabilityDecision：父进程失联按 deny（不无限干等）", async () => {
  const request = makeCapabilityRequest({ capability: "command", command: "x", reason: "r", cwd: "/tmp" });
  const { opts, clock } = waitOpts({ readDecision: () => undefined, parentAlive: () => false, healthMs: 100_000 });
  const decision = await waitForCapabilityDecision(request.requestId, opts);
  assert.equal(decision.action, "deny");
  assert.match(decision.comment ?? "", /失联/);
  assert(clock() >= 100_000);
});

test("waitForCapabilityDecision：等待超时按 deny", async () => {
  const request = makeCapabilityRequest({ capability: "command", command: "x", reason: "r", cwd: "/tmp" });
  const { opts } = waitOpts({ readDecision: () => undefined, timeoutMs: 5000, healthMs: 10_000_000 });
  const decision = await waitForCapabilityDecision(request.requestId, opts);
  assert.equal(decision.action, "deny");
  assert.match(decision.comment ?? "", /超时/);
});
