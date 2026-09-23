// guard.test.ts — 黑名单解析与路径/命令拦截测试
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/guard.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { loadBlacklist, pathBlocked, commandBlocked, writePathBlocked, readWorkerWriteScope, workerWriteBlocked, targetPathOf } from "./guard.ts";
import guardExtension from "./guard.ts";
import { setYolo } from "./yolo.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

describe("黑名单加载", () => {
  it("读默认黑名单文件并编译规则", () => {
    const rules = loadBlacklist();
    assert.ok(rules.length >= 10, `默认黑名单应 >= 10 条，实际 ${rules.length}`);
  });
});

describe("pathBlocked（路径拦截）", () => {
  const rules = loadBlacklist();
  const home = homedir();

  it("~/.ssh 下任意路径命中", () => {
    assert.equal(pathBlocked("~/.ssh/id_rsa", "/work", rules), true);
    assert.equal(pathBlocked(`${home}/.ssh/config`, "/work", rules), true);
  });

  it("auth.json / providers.toml 命中", () => {
    assert.equal(pathBlocked(`${home}/.pi/agent/auth.json`, "/work", rules), true);
    assert.equal(pathBlocked(`${home}/.pi/agent/providers.toml`, "/work", rules), true);
  });

  it("浏览器 profile 命中", () => {
    assert.equal(pathBlocked(`${home}/.config/google-chrome/Default/Login Data`, "/work", rules), true);
  });

  it("项目 .env 命中（相对与绝对）", () => {
    assert.equal(pathBlocked(".env", "/work/project", rules), true);
    assert.equal(pathBlocked("/work/project/.env.local", "/work/project", rules), true);
  });

  it("普通工作文件不命中", () => {
    assert.equal(pathBlocked("/work/project/src/main.ts", "/work/project", rules), false);
    assert.equal(pathBlocked(`${home}/.pi/agent/settings.json`, "/work", rules), false);
  });
});

describe("commandBlocked（bash 命令拦截）", () => {
  const rules = loadBlacklist();

  it("cat ~/.ssh/id_rsa 命中", () => {
    assert.equal(commandBlocked("cat ~/.ssh/id_rsa", rules), true);
  });

  it("展开路径形式命中", () => {
    assert.equal(commandBlocked(`cat ${homedir()}/.ssh/config`, rules), true);
  });

  it("安全命令不命中", () => {
    assert.equal(commandBlocked("ls -la && git status", rules), false);
    assert.equal(commandBlocked("cat package.json", rules), false);
  });

  it(".env 路径段命中", () => {
    assert.equal(commandBlocked("cat /work/project/.env", rules), true);
  });
});

describe("writePathBlocked（仅写保护路径，原 protected-paths 并入）", () => {
  it(".git/ 与 node_modules/ 命中（相对与绝对）", () => {
    assert.equal(writePathBlocked(".git/config"), true);
    assert.equal(writePathBlocked("/work/proj/.git/HEAD"), true);
    assert.equal(writePathBlocked("node_modules/foo/index.js"), true);
    assert.equal(writePathBlocked("/work/proj/node_modules/foo/index.js"), true);
  });

  it(".env 及 .env.* 命中（比黑名单 .env/.env.local 更宽）", () => {
    assert.equal(writePathBlocked(".env"), true);
    assert.equal(writePathBlocked(".env.production"), true);
    assert.equal(writePathBlocked("/work/proj/.env.test.local"), true);
  });

  it("普通文件不命中", () => {
    assert.equal(writePathBlocked("src/main.ts"), false);
    assert.equal(writePathBlocked("/work/proj/README.md"), false);
    assert.equal(writePathBlocked(""), false);
  });
});

describe("readWorkerWriteScope（worker 可写根）", () => {
  it("非 worker（主进程）不适用", () => {
    assert.equal(readWorkerWriteScope({}), undefined);
    assert.equal(readWorkerWriteScope({ PI_SANDBOX_READONLY: "1" }), undefined);
  });

  it("worktree：PI_SANDBOX_RW + /tmp，非只读", () => {
    const scope = readWorkerWriteScope({ PI_SUBAGENT: "1", PI_SANDBOX_RW: "/work/wt" });
    assert.deepEqual(scope, { roots: ["/tmp", "/work/wt"], readonly: false });
  });

  it("readonly：忽略 PI_SANDBOX_RW，只留 /tmp", () => {
    const scope = readWorkerWriteScope({
      PI_SUBAGENT: "1",
      PI_SANDBOX_READONLY: "1",
      PI_SANDBOX_RW: "/work/wt",
    });
    assert.deepEqual(scope, { roots: ["/tmp"], readonly: true });
  });

  it("readonly + RW_EXTRA：一次性升权的额外根仍生效", () => {
    const scope = readWorkerWriteScope({
      PI_SUBAGENT: "1",
      PI_SANDBOX_READONLY: "1",
      PI_SANDBOX_RW_EXTRA: "/extra/a:/extra/b",
    });
    assert.deepEqual(scope?.roots, ["/tmp", "/extra/a", "/extra/b"]);
    assert.equal(scope?.readonly, true);
  });

  it("降零（PI_SANDBOX_DISABLE=1）不拦", () => {
    assert.equal(
      readWorkerWriteScope({ PI_SUBAGENT: "1", PI_SANDBOX_DISABLE: "1", PI_SANDBOX_READONLY: "1" }),
      undefined,
    );
  });

  it("只读但没设任何档位来源时不管（避免影响未知调用方）", () => {
    assert.equal(readWorkerWriteScope({ PI_SUBAGENT: "1" }), undefined);
  });
});

describe("workerWriteBlocked（write/edit 边界）", () => {
  const readonlyScope = { roots: ["/tmp"], readonly: true };
  const worktreeScope = { roots: ["/tmp", "/work/wt"], readonly: false };

  it("只读档位：/tmp 可写，工程目录不可写", () => {
    assert.equal(workerWriteBlocked("/tmp/scratch.txt", "/work/proj", readonlyScope), undefined);
    assert.equal(workerWriteBlocked("src/main.ts", "/work/proj", readonlyScope) !== undefined, true);
    assert.equal(workerWriteBlocked("/work/proj/src/main.ts", "/work/proj", readonlyScope) !== undefined, true);
  });

  it("worktree 档位：根内（含相对路径）可写，根外不可写", () => {
    assert.equal(workerWriteBlocked("/work/wt/src/a.ts", "/work/wt", worktreeScope), undefined);
    assert.equal(workerWriteBlocked("src/a.ts", "/work/wt", worktreeScope), undefined);
    assert.equal(workerWriteBlocked("../outside.ts", "/work/wt", worktreeScope) !== undefined, true);
    assert.equal(workerWriteBlocked("/work/other/a.ts", "/work/wt", worktreeScope) !== undefined, true);
  });

  it("可写根本身可写", () => {
    assert.equal(workerWriteBlocked("/work/wt", "/work/wt", worktreeScope), undefined);
  });

  it("路径段边界：/tmpfoo 不冒充当 /tmp", () => {
    assert.equal(workerWriteBlocked("/tmpfoo/a.ts", "/work", readonlyScope) !== undefined, true);
  });

  it("拒绝理由说明当前档位与修法", () => {
    const reason = workerWriteBlocked("/work/proj/a.ts", "/work/proj", readonlyScope);
    assert.match(reason ?? "", /sandbox-guard/);
    assert.match(reason ?? "", /只读档位/);
    assert.match(reason ?? "", /主 agent/);
  });

  it("真实路径判断：根内（含尚不存在的新文件）不拦，根外拦", () => {
    const base = mkdtempSync(joinPath(tmpdir(), "guard-scope-"));
    const outside = joinPath(base, "outside");
    const root = joinPath(base, "root");
    mkdirSync(outside);
    mkdirSync(root);
    const scope = { roots: [root], readonly: false };
    // 根内新建文件（不存在也要能判断）不拦
    assert.equal(workerWriteBlocked(joinPath(root, "new.ts"), root, scope), undefined);
    assert.equal(workerWriteBlocked(joinPath(outside, "x.ts"), root, scope) !== undefined, true);
  });
});

describe("targetPathOf（读写通道的目标路径）", () => {
  it("内置 read / write / edit 取 path", () => {
    assert.equal(targetPathOf("read", { path: "/a/b.ts" }, "read"), "/a/b.ts");
    assert.equal(targetPathOf("write", { path: "/a/b.ts", content: "x" }, "write"), "/a/b.ts");
    assert.equal(targetPathOf("edit", { path: "/a/b.ts", edits: [] }, "write"), "/a/b.ts");
  });

  it("be-* 写入通道取 file（否则整条 MCP 写通道绕过拦截）", () => {
    for (const tool of ["be-write", "be-replace", "be-insert", "be-delete"]) {
      assert.equal(targetPathOf(tool, { file: "/a/b.ts", content: "x" }, "write"), "/a/b.ts", tool);
    }
  });

  it("be-* 的 file 可带 :行范围 与 :ALL 后缀", () => {
    assert.equal(targetPathOf("be-replace", { file: "src/a.ts:10-15" }, "write"), "src/a.ts");
    assert.equal(targetPathOf("be-delete", { file: "src/a.ts:7" }, "write"), "src/a.ts");
    assert.equal(targetPathOf("be-delete", { file: "src/a.ts:ALL" }, "write"), "src/a.ts");
  });

  it("be-insert-chip 取 to（file:// 前缀剥掉）", () => {
    assert.equal(targetPathOf("be-insert-chip", { from: "chip://x", to: "file:///a/b.ts:3" }, "write"), "/a/b.ts");
  });

  it("be-insert-chip 的 from 是 file:// 时按读路径算（取内容也是读）", () => {
    assert.equal(targetPathOf("be-insert-chip", { from: "file:///a/b.ts" }, "read"), "/a/b.ts");
    assert.equal(targetPathOf("be-insert-chip", { from: "chip://abc123" }, "read"), undefined);
  });

  it("be-read 走 read 通道，不在 write 表里", () => {
    assert.equal(targetPathOf("be-read", { file: "~/.ssh/id_rsa" }, "read"), "~/.ssh/id_rsa");
    assert.equal(targetPathOf("be-read", { file: "/a/b.ts" }, "write"), undefined);
  });

  it("不相干的工具 / 空入参 / 空路径返回 undefined", () => {
    assert.equal(targetPathOf("bash", { command: "rm -rf /" }, "write"), undefined);
    assert.equal(targetPathOf("be-trx", { action: "rollback" }, "write"), undefined);
    assert.equal(targetPathOf("be-read", { brief: true }, "read"), undefined);
    assert.equal(targetPathOf("read", { path: "   " }, "read"), undefined);
    assert.equal(targetPathOf("read", undefined, "read"), undefined);
  });
});

describe("tool_call 钩子（工具分发，不只是纯函数）", () => {
  type Handler = (event: { toolName: string; input: unknown }, ctx: { cwd: string }) => { block?: boolean; reason?: string } | undefined;

  function toolCallHandler(): Handler {
    const registered: Record<string, Handler[]> = {};
    const pi = {
      on: (event: string, handler: Handler) => {
        (registered[event] ??= []).push(handler);
      },
    } as unknown as Parameters<typeof guardExtension>[0];
    guardExtension(pi);
    const handlers = registered["tool_call"];
    assert.ok(handlers && handlers.length > 0, "guard 必须注册 tool_call 钩子");
    return handlers[0];
  }

  const handler = toolCallHandler();
  const ctx = { cwd: "/work/proj" };

  it("be-write / be-delete 写黑名单路径被拦（旧代码只认 write/edit，这条通道是开的）", () => {
    for (const toolName of ["be-write", "be-replace", "be-insert", "be-delete"]) {
      const res = handler({ toolName, input: { file: `${homedir()}/.ssh/authorized_keys` } }, ctx);
      assert.equal(res?.block, true, toolName);
    }
  });

  it("内置 write / edit 仍被拦（重构不得把它弄丢）", () => {
    assert.equal(handler({ toolName: "write", input: { path: ".git/config" } }, ctx)?.block, true);
    assert.equal(handler({ toolName: "edit", input: { path: "node_modules/x/i.js" } }, ctx)?.block, true);
  });

  it("be-read 读黑名单路径被拦，普通路径放行", () => {
    assert.equal(handler({ toolName: "be-read", input: { file: `${homedir()}/.ssh/id_rsa` } }, ctx)?.block, true);
    assert.equal(handler({ toolName: "be-read", input: { file: "src/main.ts" } }, ctx), undefined);
  });

  it("be-insert-chip 从黑名单文件取内容也被拦", () => {
    const res = handler({ toolName: "be-insert-chip", input: { from: `file://${homedir()}/.ssh/id_rsa` } }, ctx);
    assert.equal(res?.block, true);
    assert.equal(handler({ toolName: "be-insert-chip", input: { from: "chip://xxxx" } }, ctx), undefined);
  });

  it("worker 写入边界对 be-* 同样生效", () => {
    const backup = { ...process.env };
    try {
      process.env.PI_SUBAGENT = "1";
      process.env.PI_SANDBOX_RW = "/work/wt";
      delete process.env.PI_SANDBOX_READONLY;
      delete process.env.PI_SANDBOX_DISABLE;
      assert.equal(handler({ toolName: "be-write", input: { file: "/work/elsewhere/x.ts" } }, ctx)?.block, true);
      assert.equal(handler({ toolName: "be-write", input: { file: "/work/wt/x.ts" } }, ctx), undefined);
      assert.equal(handler({ toolName: "write", input: { path: "/work/elsewhere/x.ts" } }, ctx)?.block, true);
    } finally {
      for (const key of ["PI_SUBAGENT", "PI_SANDBOX_RW", "PI_SANDBOX_READONLY", "PI_SANDBOX_DISABLE"]) delete process.env[key];
      Object.assign(process.env, backup);
    }
  });

  it("yolo 下不拦（现有行为保持一致）", () => {
    setYolo(true);
    try {
      assert.equal(handler({ toolName: "be-write", input: { file: `${homedir()}/.ssh/authorized_keys` } }, ctx), undefined);
    } finally {
      setYolo(false);
    }
  });
});
