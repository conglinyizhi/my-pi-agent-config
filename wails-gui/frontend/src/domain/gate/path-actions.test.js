import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendScopeRow,
  cancelPathAuthorization,
  checkScopeEdit,
  checkWorkspacePath,
  createScopeRows,
  cyclePathDraft,
  editScopeRow,
  hasExactGrant,
  isBuiltinWritable,
  normalizeScopePath,
  pathDraftsToActions,
  pathDraftSummary,
  pathRowModel,
  removeScopeRow,
  scopeChanged,
  scopeIssues,
  scopeRowModel,
  scopeWritePaths,
  workspaceActions,
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

const scopeOptions = { homeDir: "/home/tester", workspaceRoot: "/work/project" };

describe("Gate 执行范围编辑与副工作区", () => {
  it("归一化 ~、相对路径与 . / ..；根目录与空值拒绝", () => {
    assert.equal(normalizeScopePath("/opt/a/./b/../c", scopeOptions), "/opt/a/c");
    assert.equal(normalizeScopePath("~/disk/ai_workspace", scopeOptions), "/home/tester/disk/ai_workspace");
    assert.equal(normalizeScopePath("out/build", scopeOptions), "/work/project/out/build");
    assert.equal(normalizeScopePath("/", scopeOptions), null);
    assert.equal(normalizeScopePath("   ", scopeOptions), null);
    assert.equal(normalizeScopePath("/../", scopeOptions), null);
    assert.equal(normalizeScopePath("~/x", { workspaceRoot: "/work/project" }), null);
  });

  it("编辑范围只放行原始候选的父/子（同路径也算）", () => {
    const candidates = ["/tmp/tmp.abc"];
    assert.equal(checkScopeEdit("/tmp", candidates, scopeOptions).ok, true);
    assert.equal(checkScopeEdit("/tmp/tmp.abc/sub", candidates, scopeOptions).ok, true);
    assert.equal(checkScopeEdit("/tmp/tmp.abc", candidates, scopeOptions).ok, true);
    const outside = checkScopeEdit("/home/tester/disk/ai_workspace", candidates, scopeOptions);
    assert.equal(outside.ok, false);
    assert.equal(outside.path, "/home/tester/disk/ai_workspace");
    assert.equal(outside.candidate, null);
    assert.equal(outside.reason, "必须与原始候选互为父/子目录");
    assert.equal(checkScopeEdit("/", candidates, scopeOptions).ok, false);
  });

  it("副工作区允许任意目录，只挡 / 与家目录根", () => {
    assert.equal(checkWorkspacePath("~/disk/ai_workspace", scopeOptions).path, "/home/tester/disk/ai_workspace");
    assert.equal(checkWorkspacePath("/srv/data", scopeOptions).ok, true);
    const home = checkWorkspacePath("/home/tester", scopeOptions);
    assert.equal(home.ok, false);
    assert.match(home.reason, /家目录根/);
    assert.equal(checkWorkspacePath("/", scopeOptions).ok, false);
    assert.equal(checkWorkspacePath("", scopeOptions).ok, false);
  });

  it("行的增删改不改原数组，key 稳定且新增行从 n1 起", () => {
    const rows = createScopeRows(["/tmp/tmp.abc", "/opt/cache"]);
    assert.deepEqual(rows, [
      { key: "c0", candidate: "/tmp/tmp.abc", path: "/tmp/tmp.abc" },
      { key: "c1", candidate: "/opt/cache", path: "/opt/cache" },
    ]);
    const edited = editScopeRow(rows, "c0", "/tmp");
    assert.equal(edited[0].path, "/tmp");
    assert.equal(rows[0].path, "/tmp/tmp.abc");
    const added = appendScopeRow(edited, "/tmp/other");
    assert.equal(added[2].key, "n1");
    assert.equal(added[2].candidate, null);
    const addedMore = appendScopeRow(added, "/tmp/other2");
    assert.deepEqual(addedMore.map((row) => row.key), ["c0", "c1", "n1", "n2"]);
    assert.deepEqual(removeScopeRow(added, "c1").map((row) => row.key), ["c0", "n1"]);
  });

  it("没动过范围就不发 writePaths，动过一条必须发完整列表", () => {
    const candidates = ["/tmp/tmp.abc", "/opt/cache"];
    const rows = createScopeRows(candidates);
    assert.equal(scopeChanged(rows, candidates, scopeOptions), false);
    assert.equal(scopeChanged(editScopeRow(rows, "c0", "/tmp/tmp.abc"), candidates, scopeOptions), false);
    const edited = editScopeRow(rows, "c0", "/tmp");
    assert.equal(scopeChanged(edited, candidates, scopeOptions), true);
    assert.deepEqual(scopeWritePaths(edited, scopeOptions), ["/tmp", "/opt/cache"]);
    const removed = removeScopeRow(rows, "c1");
    assert.equal(scopeChanged(removed, candidates, scopeOptions), true);
    assert.deepEqual(scopeWritePaths(removed, scopeOptions), ["/tmp/tmp.abc"]);
    assert.deepEqual(scopeWritePaths(rows, scopeOptions), ["/tmp/tmp.abc", "/opt/cache"]);
    assert.deepEqual(scopeWritePaths([], scopeOptions), []);
    assert.equal(scopeChanged([], candidates, scopeOptions), true);
  });

  it("范围外的行会被 scopeIssues 点名", () => {
    const rows = appendScopeRow(createScopeRows(["/tmp/tmp.abc"]), "/etc");
    const issues = scopeIssues(rows, ["/tmp/tmp.abc"], scopeOptions);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].key, "n1");
    assert.equal(issues[0].path, "/etc");
    assert.equal(issues[0].reason, "必须与原始候选互为父/子目录");
    assert.deepEqual(scopeIssues(createScopeRows(["/tmp/tmp.abc"]), ["/tmp/tmp.abc"], scopeOptions), []);
    assert.equal(scopeIssues(editScopeRow(rows, "c0", ""), ["/tmp/tmp.abc"], scopeOptions).length, 2);
  });

  it("行模型只在路径仍是原候选时挂授权按钮", () => {
    const context = { ...scopeOptions, roots, drafts: {} };
    const rows = createScopeRows(["/opt/new"]);
    const intact = scopeRowModel(rows[0], ["/opt/new"], context);
    assert.equal(intact.trustable, true);
    assert.equal(intact.label, "本次新增");
    assert.equal(intact.trust.showPersistent, true);
    const moved = scopeRowModel(editScopeRow(rows, "c0", "/opt")[0], ["/opt/new"], context);
    assert.equal(moved.guard.ok, true);
    assert.equal(moved.trustable, false);
    assert.equal(moved.trust, null);
    assert.equal(moved.label, "本次新增");
    const broken = scopeRowModel(editScopeRow(rows, "c0", "/etc")[0], ["/opt/new"], context);
    assert.equal(broken.guard.ok, false);
    assert.equal(broken.trustable, false);
    assert.equal(broken.label, "路径无效");
    const added = scopeRowModel(appendScopeRow(rows, "/opt/new/sub")[1], ["/opt/new"], context);
    assert.equal(added.added, true);
    assert.equal(added.guard.ok, true);
    assert.equal(added.trustable, false);
    const granted = scopeRowModel(rows[0], ["/opt/new"], { ...context, roots: { ...roots, persistentRoots: ["/opt/new"] } });
    assert.equal(granted.label, "长期信任");
    assert.equal(granted.trust.showPersistent, false);
  });

  it("副工作区动作一次可以给多个目录", () => {
    assert.deepEqual(workspaceActions(["/home/tester/disk/ai_workspace", "/srv/data"]), [
      { path: "/home/tester/disk/ai_workspace", list: "workspace" },
      { path: "/srv/data", list: "workspace" },
    ]);
    assert.deepEqual(workspaceActions([]), []);
    assert.deepEqual(workspaceActions(undefined), []);
  });
});
