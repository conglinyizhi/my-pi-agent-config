import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cancelPathAuthorization,
  cyclePathDraft,
  hasExactGrant,
  pathDraftsToActions,
  pathDraftSummary,
  pathRowModel,
} from "./path-actions.js";

const roots = {
  persistentRoots: ["/opt/long"],
  sessionTrustedRoots: ["/tmp/trust"],
  sessionWriteRoots: ["/tmp/write"],
};

describe("Gate path authorization drafts", () => {
  it("last-wins per path and toggling the same action clears the draft", () => {
    let drafts = cyclePathDraft({}, "/tmp/a", "allow");
    drafts = cyclePathDraft(drafts, "/tmp/b", "session-trust");
    drafts = cyclePathDraft(drafts, "/tmp/a", "block");
    assert.deepEqual(pathDraftsToActions(drafts), [
      { path: "/tmp/a", list: "block" },
      { path: "/tmp/b", list: "session-trust" },
    ]);
    drafts = cyclePathDraft(drafts, "/tmp/a", "block");
    assert.deepEqual(pathDraftsToActions(drafts), [{ path: "/tmp/b", list: "session-trust" }]);
  });

  it("does not mutate the previous drafts object", () => {
    const original = { "/tmp/a": "allow" };
    const next = cyclePathDraft(original, "/tmp/b", "block");
    assert.equal(original["/tmp/b"], undefined);
    assert.equal(next["/tmp/a"], "allow");
    assert.equal(next["/tmp/b"], "block");
  });

  it("cancel clears a draft before staging revoke", () => {
    const drafted = cancelPathAuthorization({ "/tmp/a": "allow" }, "/tmp/a", roots);
    assert.deepEqual(drafted, {});
    const revoked = cancelPathAuthorization({}, "/opt/long", roots);
    assert.deepEqual(revoked, { "/opt/long": "revoke" });
  });

  it("cancel is a no-op when there is no draft and no exact grant", () => {
    assert.equal(hasExactGrant("/opt/long/sub", roots), false);
    assert.deepEqual(cancelPathAuthorization({}, "/opt/long/sub", roots), {});
    assert.deepEqual(cancelPathAuthorization({}, "/tmp/new", roots), {});
  });

  it("prefix coverage is not an exact grant, so parent roots cannot be revoked from a child row", () => {
    const row = pathRowModel("/opt/long/build", roots, {});
    assert.equal(row.label, "长期信任");
    assert.equal(row.showPersistent, false);
    assert.equal(row.cancelLabel, null);
  });

  it("shows grant buttons and cancel-revoke for an exact existing grant", () => {
    const row = pathRowModel("/tmp/trust", roots, {});
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
    const row = pathRowModel("/tmp/new", roots, { "/tmp/new": "allow" });
    assert.equal(row.label, "将长期信任");
    assert.equal(row.showPersistent, true);
    assert.equal(row.persistentPending, true);
    assert.equal(row.cancelLabel, "取消标记");
  });

  it("summarizes staged operations for the action bar", () => {
    assert.equal(pathDraftSummary({}), "");
    assert.equal(pathDraftSummary({ "/a": "allow", "/b": "revoke" }), "已暂存 2 项目录操作");
  });
});
