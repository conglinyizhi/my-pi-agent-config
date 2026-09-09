// 回归测试：/session-switch:fast-fork 在 fork 成功、旧 ctx 失效后，
// 不能再读写旧 ctx（pi 的 ctx 是惰性 getter，读 ctx.ui 就会抛 stale 错误）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import registerSessionBrowse from "./index.ts";

// 让 logStaleCtx 写进临时目录，不污染真实的 ~/.pi/agent/tool-errors.log
const agentDir = mkdtempSync(join(tmpdir(), "pi-session-browse-stale-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const errorLog = join(agentDir, "tool-errors.log");
after(() => rmSync(agentDir, { recursive: true, force: true }));

const STALE_MESSAGE =
  "This extension ctx is stale after session replacement or reload. " +
  "Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), " +
  "ctx.switchSession(), or ctx.reload().";

type Notify = { message: string; level: string };

/** 造一个 pi stub，返回注册进去的 command handler */
function loadFastFork() {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      if (name === "session-switch:fast-fork") handler = options.handler;
    },
  };
  registerSessionBrowse(pi as never);
  assert.ok(handler, "fast-fork command 未注册");
  return handler;
}

/** 模拟 pi 的 session 替换：替换发生后旧 ctx 失效（读 ctx.ui 就抛） */
function makeCtx(options: {
  fork: (leafId: string, opts: any) => Promise<{ cancelled: boolean }>;
}) {
  const notifications: Notify[] = [];
  const statuses: Array<string | undefined> = [];
  const ui = {
    notify: (message: string, level = "info") => notifications.push({ message, level }),
    setStatus: (_key: string, value?: string) => statuses.push(value),
  };
  let stale = false;
  const ctx = {
    sessionManager: { getLeafId: () => "leaf-1" },
    get ui() {
      if (stale) throw new Error(STALE_MESSAGE);
      return ui;
    },
    fork: options.fork,
  };
  return {
    ctx,
    notifications,
    statuses,
    invalidate: () => {
      stale = true;
    },
  };
}

describe("session-switch:fast-fork 的 stale ctx 防护", () => {
  it("fork 成功后不碰旧 ctx，收尾走 withSession 的新 ctx", async () => {
    const handler = loadFastFork();
    const newNotifications: Notify[] = [];
    const newCtx = {
      ui: {
        notify: (message: string, level = "info") => newNotifications.push({ message, level }),
        setStatus: () => {},
      },
    };

    const { ctx, notifications, statuses, invalidate } = makeCtx({
      fork: async (_leafId, opts) => {
        await opts.withSession(newCtx);
        invalidate(); // 替换完成，旧 ctx 失效
        return { cancelled: false };
      },
    });

    await handler("", ctx);

    assert.deepEqual(notifications, [], "成功路径不应再向旧 ctx 发通知");
    assert.deepEqual(statuses, ["fork session…"], "成功路径不应在旧 ctx 上清 status");
    assert.deepEqual(newNotifications, [
      { message: "已 fork 到新 session，可继续对话", level: "info" },
    ]);
  });

  it("fork 被取消时旧 ctx 仍有效，照常通知并清 status", async () => {
    const handler = loadFastFork();
    const { ctx, notifications, statuses } = makeCtx({
      // 取消发生在 teardown 之前，旧 ctx 仍然有效
      fork: async () => ({ cancelled: true }),
    });

    await handler("", ctx);

    assert.deepEqual(notifications, [{ message: "fork 被取消", level: "warning" }]);
    assert.deepEqual(statuses, ["fork session…", undefined]);
  });

  it("替换已完成后再出错，不能把旧 ctx 的 stale 错误抛出去", async () => {
    const handler = loadFastFork();
    const newCtx = {
      ui: {
        notify: () => {
          throw new Error("withSession 内部炸了");
        },
        setStatus: () => {},
      },
    };

    const { ctx, notifications, statuses, invalidate } = makeCtx({
      fork: async (_leafId, opts) => {
        await opts.withSession(newCtx).catch(() => {});
        invalidate(); // 替换已经完成
        throw new Error("替换后 createRuntime 失败");
      },
    });

    await assert.doesNotReject(() => handler("", ctx));
    assert.deepEqual(notifications, [], "旧 ctx 已失效，不该再发通知");
    assert.deepEqual(statuses, ["fork session…"], "旧 ctx 已失效，不该再清 status");
    assert.match(readFileSync(errorLog, "utf-8"), /旧 ctx 已失效，跳过收尾 UI/);
  });

  it("替换尚未发生就失败时，仍向旧 ctx 报错", async () => {
    const handler = loadFastFork();
    const { ctx, notifications, statuses } = makeCtx({
      fork: async () => {
        throw new Error("This session has not been saved yet");
      },
    });

    await handler("", ctx);

    assert.deepEqual(notifications, [
      { message: "fork 失败: This session has not been saved yet", level: "error" },
    ]);
    assert.deepEqual(statuses, ["fork session…", undefined]);
  });
});
