// gui-runner.test.ts — launchGuiWindow 非阻塞启动 + runGuiWindow spawn 失败
//
// launchGuiWindow 与 runGuiWindow 的区别：spawn 成功后立即返回，不等待
// response.json / .ready / 超时 / 窗口关闭。进程创建通过注入 findBin/spawnFn
// 隔离，测试不真正拉起 wails-gui。
//
// runGuiWindow 部分覆盖：spawn emit 'error'（二进制不可执行 / 路径失效）时必须
// 被接住并返回 reason:"spawn"，而不是把未捕获异常抛穿整个进程。
//
// 跑法：node --experimental-strip-types lib/gui-runner.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { getEventListeners } from "node:events";
import type { ChildProcess } from "node:child_process";
import { launchGuiWindow, runGuiWindow } from "./gui-runner.ts";

interface FakeChild {
  unrefCalled: boolean;
  killCalled: boolean;
  killSignal: string | null;
  handlers: Map<string, Array<() => void>>;
  unref(): void;
  kill(sig?: string): boolean;
  on(ev: string, cb: () => void): FakeChild;
  emit(ev: string): void;
}

/** 构造可注入的假 spawn：记录调用参数，返回可手动触发事件（close/error）的假子进程 */
function makeFakeSpawn() {
  const calls: Array<{ bin: string; args: string[]; opts: unknown }> = [];
  const fakeChild: FakeChild = {
    unrefCalled: false,
    killCalled: false,
    killSignal: null,
    handlers: new Map(),
    unref() {
      this.unrefCalled = true;
    },
    kill(sig) {
      this.killCalled = true;
      this.killSignal = sig ?? null;
      return true;
    },
    on(ev, cb) {
      const list = this.handlers.get(ev) ?? [];
      list.push(cb);
      this.handlers.set(ev, list);
      return this;
    },
    emit(ev) {
      for (const cb of this.handlers.get(ev) ?? []) cb();
    },
  };
  const spawnFn = (bin: string, args: string[], opts: unknown) => {
    calls.push({ bin, args, opts });
    return fakeChild as unknown as ChildProcess;
  };
  return { spawnFn, calls, fakeChild };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 临时目录里 pi-<name>- 前缀目录的数量（用来验证失败后不留垃圾） */
function countTmpDirs(prefix: string): number {
  return fs.readdirSync(tmpdir()).filter((n) => n.startsWith(prefix)).length;
}

describe("launchGuiWindow", () => {
  it("无二进制路径：不 spawn，直接返回 unavailable", () => {
    const { spawnFn, fakeChild } = makeFakeSpawn();
    const r = launchGuiWindow("subagents", {}, { findBin: () => null, spawnFn });
    assert.deepStrictEqual(r, { ok: false, reason: "unavailable" });
    // 从未走到 spawn（unref 只在 spawn 成功后调用）
    assert.strictEqual(fakeChild.unrefCalled, false);
  });

  it("spawn 成功：同步返回 ok:true，不等待 response/close", () => {
    const { spawnFn, calls, fakeChild } = makeFakeSpawn();
    const request = { feedback: true, workers: [{ id: "w1", status: "running" }] };
    const r = launchGuiWindow("subagents", request, { findBin: () => "/fake/wails-gui", spawnFn });

    // 同步返回普通对象（非 Promise）：没有等待 response.json / 超时 / 窗口关闭
    assert.strictEqual(r instanceof Promise, false);
    assert.deepStrictEqual(r, { ok: true });

    assert.strictEqual(calls.length, 1);
    const call = calls[0];
    assert.strictEqual(call.bin, "/fake/wails-gui");
    assert.strictEqual(call.args[0], "subagents");
    assert.deepStrictEqual(call.opts, { stdio: "ignore", detached: true });
    assert.strictEqual(fakeChild.unrefCalled, true);

    // request 已写入私有临时目录，spawn 时子进程即可读
    const requestFile = call.args[1];
    const tmpDir = path.dirname(requestFile);
    assert.match(tmpDir, /pi-subagents-/);
    assert(fs.existsSync(requestFile));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(requestFile, "utf-8")), request);

    // response 文件尚未创建（launch 不等待它）
    assert(!fs.existsSync(call.args[2]));

    // 子进程一直不退出（模拟常驻监视窗口）→ 临时目录保留；close 后才清理
    assert(fs.existsSync(tmpDir));
    fakeChild.emit("close");
    assert(!fs.existsSync(tmpDir));
  });

  it("spawn 抛错：返回 spawn 失败，且不留临时目录", () => {
    const before = fs.readdirSync(tmpdir()).filter((n) => n.startsWith("pi-subagents-")).length;
    const spawnFn = () => {
      throw new Error("ENOENT");
    };
    const r = launchGuiWindow("subagents", {}, { findBin: () => "/fake/wails-gui", spawnFn });
    assert.deepStrictEqual(r, { ok: false, reason: "spawn" });
    const after = fs.readdirSync(tmpdir()).filter((n) => n.startsWith("pi-subagents-")).length;
    assert.strictEqual(after, before);
  });

  it("子进程 error 事件（spawn 后启动失败）：清理临时目录", () => {
    const { spawnFn, calls, fakeChild } = makeFakeSpawn();
    const r = launchGuiWindow("subagents", { x: 1 }, { findBin: () => "/fake/wails-gui", spawnFn });
    assert.strictEqual(r.ok, true);
    const tmpDir = path.dirname(calls[0].args[1]);
    assert(fs.existsSync(tmpDir));
    fakeChild.emit("error");
    assert(!fs.existsSync(tmpDir));
  });
});

describe("runGuiWindow spawn 失败", () => {
  it("注入 findBin 未命中：不 spawn，直接返回 unavailable", async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const r = await runGuiWindow("gate", {}, { findBin: () => null, spawnFn });
    assert.deepStrictEqual(r, { ok: false, reason: "unavailable" });
    assert.strictEqual(calls.length, 0);
  });

  it("spawn 后 emit 'error'：已被监听，返回 reason spawn 且不留临时目录", async () => {
    const before = countTmpDirs("pi-gate-");
    const { spawnFn, calls, fakeChild } = makeFakeSpawn();
    const p = runGuiWindow("gate", { command: "rm -rf /" }, {
      findBin: () => "/fake/wails-gui",
      spawnFn,
      timeoutMs: 0,
    });

    // spawn 之后立刻挂了 error 监听（否则 ChildProcess 的未监听 error 会抛穿进程）
    assert.strictEqual(fakeChild.handlers.has("error"), true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].bin, "/fake/wails-gui");
    const tmpDir = path.dirname(calls[0].args[1]);
    assert(fs.existsSync(tmpDir));

    // 真实 spawn 的 'error' 走事件而非 rejection：这里手动触发，等价于 EACCES/ENOENT
    fakeChild.emit("error");
    const r = await p;
    assert.deepStrictEqual(r, { ok: false, reason: "spawn" });

    // 从未启动的进程不该再等 close，临时目录也没了
    assert(!fs.existsSync(tmpDir));
    assert.strictEqual(countTmpDirs("pi-gate-"), before);
  });

  it("spawn error 后清掉超时定时器，且 close 不得重复结算", async () => {
    const { spawnFn, fakeChild } = makeFakeSpawn();
    const p = runGuiWindow("gate", {}, {
      findBin: () => "/fake/wails-gui",
      spawnFn,
      timeoutMs: 20,
    });
    fakeChild.emit("error");
    const r = await p;
    assert.deepStrictEqual(r, { ok: false, reason: "spawn" });

    // 定时器若没清，20ms 后到点的 timeout 分支会 kill 进程并把它算成 timeout
    await sleep(80);
    assert.strictEqual(fakeChild.killCalled, false);

    // error 之后的 close 是同一进程失败的另一面：不补读、不改写已结算结果
    fakeChild.emit("close");
    await sleep(150);
    assert.strictEqual(fakeChild.killCalled, false);
  });

  it("spawn 同步抛错：同样返回 reason spawn，不留临时目录", async () => {
    const before = countTmpDirs("pi-gate-");
    const spawnFn = () => {
      throw new Error("EACCES");
    };
    const r = await runGuiWindow("gate", {}, { findBin: () => "/fake/wails-gui", spawnFn });
    assert.deepStrictEqual(r, { ok: false, reason: "spawn" });
    assert.strictEqual(countTmpDirs("pi-gate-"), before);
  });
});

describe("runGuiWindow 原有语义", () => {
  it("仍是导出函数", () => {
    assert.strictEqual(typeof runGuiWindow, "function");
  });

  it("读到 response.json：ok:true 带 data", async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const p = runGuiWindow("gate", {}, {
      findBin: () => "/fake/wails-gui",
      spawnFn,
      timeoutMs: 1000,
    });
    fs.writeFileSync(calls[0].args[2], JSON.stringify({ action: "allow" }));
    const r = await p;
    assert.deepStrictEqual(r, { ok: true, data: { action: "allow" } });
  });

  it("进程退出且没有响应：reason exited", async () => {
    const { spawnFn, fakeChild } = makeFakeSpawn();
    const p = runGuiWindow("gate", {}, {
      findBin: () => "/fake/wails-gui",
      spawnFn,
      timeoutMs: 0,
    });
    fakeChild.emit("close");
    const r = await p;
    assert.deepStrictEqual(r, { ok: false, reason: "exited" });
  });

  it("signal 中止：reason aborted 并 kill 掉进程", async () => {
    const { spawnFn, fakeChild } = makeFakeSpawn();
    const ac = new AbortController();
    const p = runGuiWindow("gate", {}, {
      findBin: () => "/fake/wails-gui",
      spawnFn,
      timeoutMs: 0,
      signal: ac.signal,
    });
    ac.abort();
    const r = await p;
    assert.deepStrictEqual(r, { ok: false, reason: "aborted" });
    assert.strictEqual(fakeChild.killCalled, true);
    assert.strictEqual(getEventListeners(ac.signal, "abort").length, 0);
  });

  it("非 abort 结算（spawn 失败）也摘掉 abort 监听", async () => {
    const { spawnFn, fakeChild } = makeFakeSpawn();
    const ac = new AbortController();
    const p = runGuiWindow("gate", {}, {
      findBin: () => "/fake/wails-gui",
      spawnFn,
      timeoutMs: 20,
      signal: ac.signal,
    });
    assert.strictEqual(getEventListeners(ac.signal, "abort").length, 1);
    fakeChild.emit("error");
    assert.deepStrictEqual(await p, { ok: false, reason: "spawn" });
    assert.strictEqual(getEventListeners(ac.signal, "abort").length, 0);
  });

  it("超时：reason timeout 并 kill 掉进程", async () => {
    const { spawnFn, fakeChild } = makeFakeSpawn();
    const r = await runGuiWindow("gate", {}, {
      findBin: () => "/fake/wails-gui",
      spawnFn,
      timeoutMs: 20,
    });
    assert.deepStrictEqual(r, { ok: false, reason: "timeout" });
    assert.strictEqual(fakeChild.killCalled, true);
    assert.strictEqual(fakeChild.killSignal, "SIGTERM");
  });
});
