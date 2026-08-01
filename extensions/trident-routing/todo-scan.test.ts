// todo-scan.test.ts — TODO 扫描 ~ 目录跳过逻辑的行为测试
//
// 背景：cwd 恰好是 ~（home）时，rg/grep 会递归扫整个 home 树，纯浪费。
// 期望行为：默认跳过（不启动任何扫描进程，返回 { skipped: true }）；
// force: true（GUI 等用户主动触发）时照常扫描；timeout 可覆盖（0 = 不超时）。
//
// 跑法：node --experimental-strip-types extensions/trident-routing/todo-scan.test.ts

import assert from "node:assert";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scanTodos } from "./todo-scan.ts";

interface ExecCall {
  cmd: string;
  args: string[];
  opts: { timeout?: number; cwd: string };
}

/** mock pi.exec：记录调用、返回空扫描结果，不真正起进程 */
function makeMockPi() {
  const calls: ExecCall[] = [];
  const pi = {
    async exec(cmd: string, args: string[], opts: { timeout?: number; cwd: string }) {
      calls.push({ cmd, args, opts });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  };
  return { pi, calls };
}

describe("todo-scan ~ 目录跳过", () => {
  it("cwd 恰好是 ~ 时不启动 rg/grep，返回 skipped", async () => {
    const { pi, calls } = makeMockPi();
    const result = await scanTodos(pi as never, homedir());
    assert.deepStrictEqual(result, { skipped: true });
    assert.strictEqual(calls.length, 0, "~ 目录不应启动任何扫描进程");
  });

  it("cwd 带尾斜杠时同样跳过（resolve 归一化）", async () => {
    const { pi, calls } = makeMockPi();
    const result = await scanTodos(pi as never, homedir() + "/");
    assert.deepStrictEqual(result, { skipped: true });
    assert.strictEqual(calls.length, 0);
  });

  it("force: true 时 ~ 目录照常扫描", async () => {
    const { pi, calls } = makeMockPi();
    const result = await scanTodos(pi as never, homedir(), { force: true });
    assert.ok(result && !("skipped" in result), "force 场景不应返回 skipped");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.cmd, "rg");
  });

  it("非 ~ 目录照常扫描（默认行为不变）", async () => {
    const { pi, calls } = makeMockPi();
    const cwd = join(tmpdir(), "some-project");
    const result = await scanTodos(pi as never, cwd);
    assert.ok(result && !("skipped" in result), "非 ~ 目录不应跳过");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.opts.cwd, cwd);
  });

  it("默认超时 5000ms 透传给 exec", async () => {
    const { pi, calls } = makeMockPi();
    await scanTodos(pi as never, join(tmpdir(), "proj"));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.opts.timeout, 5000);
  });

  it("timeout: 0 时不设超时（GUI 场景）", async () => {
    const { pi, calls } = makeMockPi();
    await scanTodos(pi as never, join(tmpdir(), "proj"), { force: true, timeout: 0 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.opts.timeout, 0);
  });

  it("rg 不可用时回退 grep（且跳过逻辑不误伤）", async () => {
    const pi = {
      async exec(cmd: string, _args: string[], opts: { timeout?: number; cwd: string }) {
        if (cmd === "rg") throw new Error("rg not found");
        return { stdout: "", stderr: "", code: 0, killed: false, opts };
      },
    };
    const result = await scanTodos(pi as never, join(tmpdir(), "proj"));
    assert.ok(result && !("skipped" in result));
  });
});
