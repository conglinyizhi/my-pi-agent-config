// gui-runner.test.ts — launchGuiWindow 非阻塞启动测试
//
// launchGuiWindow 与 runGuiWindow 的区别：spawn 成功后立即返回，不等待
// response.json / .ready / 超时 / 窗口关闭。进程创建通过注入 findBin/spawnFn
// 隔离，测试不真正拉起 wails-gui。
//
// 跑法：node --experimental-strip-types lib/gui-runner.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { launchGuiWindow, runGuiWindow } from "./gui-runner.ts";

interface FakeChild {
  unrefCalled: boolean;
  handlers: Map<string, Array<() => void>>;
  unref(): void;
  on(ev: string, cb: () => void): FakeChild;
  emit(ev: string): void;
}

/** 构造可注入的假 spawn：记录调用参数，返回可手动触发事件（close/error）的假子进程 */
function makeFakeSpawn() {
  const calls: Array<{ bin: string; args: string[]; opts: unknown }> = [];
  const fakeChild: FakeChild = {
    unrefCalled: false,
    handlers: new Map(),
    unref() {
      this.unrefCalled = true;
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

describe("runGuiWindow 保留", () => {
  it("仍是导出函数（响应等待语义不受影响）", () => {
    assert.strictEqual(typeof runGuiWindow, "function");
  });
});
