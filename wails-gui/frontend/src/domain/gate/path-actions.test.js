import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cancelPathAuthorization,
  cyclePathDraft,
  hasExactGrant,
  isBuiltinWritable,
  pathDraftsToActions,
  pathDraftSummary,
  pathRowModel,
} from "./path-actions.js";

const roots = {
  persistentRoots: ["/opt/long"],
  sessionTrustedRoots: ["/tmp/trust"],
  sessionWriteRoots: ["/tmp/write"],
  builtinRoots: ["/work/project", "/tmp"],
  workspaceRoot: "/work/project",
};

describe("Gate path authorization drafts", () => {
  it("last-wins per path and toggling the same action clears the draft", () => {
    let drafts = cyclePathDraft({}, "/opt/a", "allow", roots);
    drafts = cyclePathDraft(drafts, "/opt/b", "session-trust", roots);
    drafts = cyclePathDraft(drafts, "/opt/a", "block", roots);
    assert.deepEqual(pathDraftsToActions(drafts), [
      { path: "/opt/a", list: "block" },
      { path: "/opt/b", list: "session-trust" },
    ]);
    drafts = cyclePathDraft(drafts, "/opt/a", "block", roots);
    assert.deepEqual(pathDraftsToActions(drafts), [{ path: "/opt/b", list: "session-trust" }]);
  });

  it("does not mutate the previous drafts object", () => {
    const original = { "/opt/a": "allow" };
    const next = cyclePathDraft(original, "/opt/b", "block", roots);
    assert.equal(original["/opt/b"], undefined);
    assert.equal(next["/opt/a"], "allow");
    assert.equal(next["/opt/b"], "block");
  });

  it("cancel clears a draft before staging revoke", () => {
    const drafted = cancelPathAuthorization({ "/opt/a": "allow" }, "/opt/a", roots);
    assert.deepEqual(drafted, {});
    const revoked = cancelPathAuthorization({}, "/opt/long", roots);
    assert.deepEqual(revoked, { "/opt/long": "revoke" });
  });

  it("cancel is a no-op when there is no draft and no exact grant", () => {
    assert.equal(hasExactGrant("/opt/long/sub", roots), false);
    assert.deepEqual(cancelPathAuthorization({}, "/opt/long/sub", roots), {});
    assert.deepEqual(cancelPathAuthorization({}, "/opt/new", roots), {});
  });

  it("prefix coverage is not an exact grant, so parent roots cannot be revoked from a child row", () => {
    const row = pathRowModel("/opt/long/build", roots, {});
    assert.equal(row.label, "长期信任");
    assert.equal(row.showPersistent, false);
    assert.equal(row.cancelLabel, null);
  });

  it("shows grant buttons and cancel-revoke for an exact existing grant", () => {
    const row = pathRowModel("/tmp/trust", roots, {});
    assert.equal(row.locked, true);
    assert.equal(row.label, "已放行");
    assert.equal(row.showPersistent, false);
    assert.equal(row.showSession, false);
    assert.equal(row.cancelLabel, null);
  });

  it("session-trusted path outside builtin roots can still be revoked", () => {
    const row = pathRowModel("/opt/session", {
      ...roots,
      sessionTrustedRoots: ["/opt/session"],
    }, {});
    assert.equal(row.label, "本 session 信任");
    assert.equal(row.showPersistent, true);
    assert.equal(row.showSession, false);
    assert.equal(row.cancelLabel, "取消授权");
  });

  it("revoke draft re-opens grant buttons and turns cancel into 取消标记", () => {
    const row = pathRowModel("/opt/long", roots, { "/opt/long": "revoke" });
    assert.equal(row.label, "将取消授权");
    assert.equal(row.pending, true);
    assert.equal(row.showPersistent, true);
    assert.equal(row.showSession, true);
    assert.equal(row.cancelLabel, "取消标记");
  });

  it("pending allow keeps the persistent button visible so it can be toggled off", () => {
    const row = pathRowModel("/opt/new", roots, { "/opt/new": "allow" });
    assert.equal(row.label, "将长期信任");
    assert.equal(row.showPersistent, true);
    assert.equal(row.persistentPending, true);
    assert.equal(row.cancelLabel, "取消标记");
  });

  it("summarizes staged operations for the action bar", () => {
    assert.equal(pathDraftSummary({}), "");
    assert.equal(pathDraftSummary({ "/a": "allow", "/b": "revoke" }), "已暂存 2 项目录操作");
  });

  it("locks builtin writable paths and ignores draft or cancel attempts", () => {
    assert.equal(isBuiltinWritable("/tmp/cache", roots), true);
    assert.equal(isBuiltinWritable("/work/project/src", roots), true);
    assert.equal(isBuiltinWritable("/opt/new", roots), false);
    const row = pathRowModel("/tmp/cache", roots, {});
    assert.equal(row.locked, true);
    assert.equal(row.label, "已放行");
    assert.equal(row.showPersistent, false);
    assert.equal(row.showBlock, false);
    assert.equal(row.cancelLabel, null);
    const workspace = pathRowModel("/work/project/out", roots, {});
    assert.equal(workspace.label, "工作区可写");
    assert.deepEqual(cyclePathDraft({}, "/tmp/cache", "allow", roots), {});
    assert.deepEqual(cancelPathAuthorization({}, "/tmp", roots), {});
  });
});
