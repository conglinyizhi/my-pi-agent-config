// lib/clipboard.test.ts — lib/clipboard 的通道路由 / stdin 写入 / OSC 52 兜底行为测试
//
// 跑法：node --experimental-strip-types lib/clipboard.test.ts
//
// 不 spawn 真进程：spawn 与 stdout 都是注入的，断言的是「发出去的 argv / stdin 字节 /
// OSC 52 序列」本身。真机（KDE Wayland + wl-copy）集成验证另见报告。

import assert from "node:assert/strict";
import {
  copyToClipboard,
  describeClipboardResult,
  emitOsc52,
  isRemoteSession,
  OSC52_TOOL,
  resolveChannels,
  type ClipboardChannel,
  type ClipboardEnv,
  type ClipboardProcess,
  type ClipboardSpawn,
} from "./clipboard.ts";

let failed = 0;

function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) {
    failed += 1;
    process.exitCode = 1;
  }
}

/** 每个 case 单独兜异常，一处炸掉不影响后面的 case 继续跑 */
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    check(name, true);
  } catch (e) {
    check(name, false, e instanceof Error ? `${e.message}` : String(e));
  }
}

// ---------------------------------------------------------------------------
// 假 spawn：记录 argv / env / stdin 字节，按 bin 决定退出行为
// ---------------------------------------------------------------------------

interface Behavior {
  /** 退出码，默认 0 */
  code?: number | null;
  signal?: string | null;
  /** 触发 'error'（模拟 ENOENT 之类起不来的情况） */
  error?: Error;
  /** 什么都不触发，等超时 */
  hang?: boolean;
}

interface SpawnCall {
  bin: string;
  args: string[];
  env: ClipboardEnv;
  chunks: Buffer[];
  ended: boolean;
  killed: boolean;
}

function makeSpawn(behave: (bin: string, callIndex: number) => Behavior) {
  const calls: SpawnCall[] = [];
  const spawnFn = ((bin: string, args: string[], options: { env: ClipboardEnv }) => {
    const call: SpawnCall = { bin, args: [...args], env: options.env, chunks: [], ended: false, killed: false };
    calls.push(call);
    const index = calls.length;

    const listeners: { error: ((err: Error) => void)[]; close: ((code: number | null, signal: string | null) => void)[] } = {
      error: [],
      close: [],
    };
    const stdin = {
      write(chunk: string) {
        call.chunks.push(Buffer.from(chunk, "utf-8"));
        return true;
      },
      end() {
        call.ended = true;
        return stdin;
      },
      on(_event: "error", _listener: (err: Error) => void) {
        return stdin;
      },
    };
    const proc = {
      stdin,
      on(event: "error" | "close", listener: (a: any, b?: any) => void) {
        listeners[event].push(listener as never);
        return proc;
      },
      kill() {
        call.killed = true;
        return true;
      },
    };

    const behavior = behave(bin, index);
    queueMicrotask(() => {
      if (behavior.hang) return;
      if (behavior.error) {
        for (const l of listeners.error) l(behavior.error);
        return;
      }
      for (const l of listeners.close) l(behavior.code ?? 0, behavior.signal ?? null);
    });
    return proc as unknown as ClipboardProcess;
  }) as ClipboardSpawn;
  return { spawnFn, calls };
}

/** 在断言期间把真实 stdout 拦下来，确认没人往测试进程 stdout 乱写 */
async function withStdoutSpy(fn: () => Promise<void>): Promise<string[]> {
  const original = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as { write: unknown }).write = original;
  }
  return captured;
}

const label = (ch: ClipboardChannel) => `${ch.bin} ${ch.args.join(" ")}`.trim();

/** 带单引号/双引号/反引号/$/分号/换行/中文的文本：进命令行就会出事的那些字符 */
const TRICKY = `单引号 ' 双引号 " 反引号 \` 美元 $HOME 分号 ; rm -rf / 换行\n第二行 中文 '\\'' 收尾`;

await test("路由：darwin → pbcopy；win32 → clip", () => {
  assert.deepEqual(resolveChannels({}, "darwin").map(label), ["pbcopy"]);
  assert.deepEqual(resolveChannels({}, "win32").map(label), ["clip"]);
  // 别的平台不该塞 unix 工具进去
  assert.deepEqual(resolveChannels({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, "darwin").map(label), ["pbcopy"]);
});

await test("路由：linux + Termux → termux-clipboard-set", () => {
  assert.deepEqual(resolveChannels({ TERMUX_VERSION: "0.118" }, "linux").map(label), ["termux-clipboard-set"]);
});

await test("路由：linux + Wayland(+DISPLAY) → wl-copy → xclip → xsel", () => {
  assert.deepEqual(resolveChannels({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, "linux").map(label), [
    "wl-copy",
    "xclip -selection clipboard",
    "xsel --clipboard --input",
  ]);
  // 只有 Wayland 时不该白试 X11 工具
  assert.deepEqual(resolveChannels({ WAYLAND_DISPLAY: "wayland-0" }, "linux").map(label), ["wl-copy"]);
});

await test("路由：linux 仅 DISPLAY → xclip → xsel", () => {
  assert.deepEqual(resolveChannels({ DISPLAY: ":0" }, "linux").map(label), ["xclip -selection clipboard", "xsel --clipboard --input"]);
});

await test("路由：无图形环境 / 非三平台 → 空列表（交给 OSC 52）", () => {
  assert.deepEqual(resolveChannels({}, "linux"), []);
  assert.deepEqual(resolveChannels({ DISPLAY: ":0" }, "freebsd"), []);
});

await test("文本不进命令行：argv 里没有文本、没有 shell -c，文本只经 stdin 走一次", async () => {
  const { spawnFn, calls } = makeSpawn(() => ({ code: 0 }));
  const osc: string[] = [];
  const attempted: string[] = [];

  const result = await copyToClipboard(TRICKY, {
    env: { WAYLAND_DISPLAY: "wayland-0" },
    platform: "linux",
    spawn: spawnFn,
    onAttempt: (tool) => attempted.push(tool),
    writeStdout: (c) => osc.push(c),
  });

  assert.equal(result.ok, true);
  assert.equal(result.tool, "wl-copy");
  assert.deepEqual(attempted, ["wl-copy"]);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.bin, "wl-copy");
  assert.deepEqual(call.args, []);
  // 所有 argv 拼起来（含 bin）都不得出现文本的任何片段
  const argvText = [call.bin, ...call.args].join("\u0000");
  for (const needle of ["单引号", "双引号", "反引号", "$HOME", "rm -rf", "第二行", "中文", "'", '"', ";"]) {
    assert.ok(!argvText.includes(needle), `argv 里出现了 ${JSON.stringify(needle)}: ${argvText}`);
  }
  // 且不是经由 shell 启动（bin 本身是工具，args 里没有 -c）
  assert.ok(!["sh", "bash", "zsh", "dash"].includes(call.bin), `bin 是 shell: ${call.bin}`);
  assert.ok(!(call.args as string[]).includes("-c"), "argv 里有 shell -c");
  // 文本只写一次、逐字节一致、写完就 end
  assert.equal(call.chunks.length, 1);
  assert.ok(Buffer.concat(call.chunks).equals(Buffer.from(TRICKY, "utf-8")), "stdin 字节与输入不一致");
  assert.equal(call.ended, true);
  assert.deepEqual(osc, [], "本地成功且非 remote 时不该发 OSC 52");
});

await test("xclip/xsel 也走 stdin：不 echo，末尾不多出 0a", async () => {
  const text = "PATH-A";
  const xclipRun = makeSpawn((bin) => ({ code: bin === "xclip" ? 0 : 1 }));
  const r1 = await copyToClipboard(text, {
    env: { DISPLAY: ":0" },
    platform: "linux",
    spawn: xclipRun.spawnFn,
    writeStdout: () => {},
  });
  assert.equal(r1.tool, "xclip");
  assert.deepEqual(xclipRun.calls[0].args, ["-selection", "clipboard"]);
  assert.ok(Buffer.concat(xclipRun.calls[0].chunks).equals(Buffer.from(text, "utf-8")));
  assert.notEqual(Buffer.concat(xclipRun.calls[0].chunks).at(-1), 0x0a);

  const xselRun = makeSpawn((bin) => ({ code: bin === "xsel" ? 0 : 1 }));
  const r2 = await copyToClipboard(text, {
    env: { DISPLAY: ":0" },
    platform: "linux",
    spawn: xselRun.spawnFn,
    writeStdout: () => {},
  });
  assert.equal(r2.tool, "xsel");
  assert.deepEqual(xselRun.calls[1].args, ["--clipboard", "--input"]);
  assert.ok(Buffer.concat(xselRun.calls[1].chunks).equals(Buffer.from(text, "utf-8")));
});

await test("wl-copy exit 0 才算成功；exit 1 回落到 xclip", async () => {
  const okRun = makeSpawn(() => ({ code: 0 }));
  const ok = await copyToClipboard("x", {
    env: { WAYLAND_DISPLAY: "wayland-0" },
    platform: "linux",
    spawn: okRun.spawnFn,
    writeStdout: () => {},
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.tool, "wl-copy");
  assert.equal(ok.attempts.length, 1, "成功就该停手，不该继续试后面的通道");
  assert.equal(okRun.calls.length, 1);

  const run = makeSpawn((bin) => (bin === "wl-copy" ? { code: 1 } : { code: 0 }));
  const attempted: string[] = [];
  const r = await copyToClipboard("x", {
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    platform: "linux",
    spawn: run.spawnFn,
    onAttempt: (t) => attempted.push(t),
    writeStdout: () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.tool, "xclip");
  assert.deepEqual(r.attempts.map((a) => a.tool), ["wl-copy", "xclip"]);
  assert.equal(r.attempts[0].ok, false);
  assert.equal(r.attempts[0].code, 1);
  assert.equal(r.attempts[0].reason, "退出码 1");
  assert.equal(r.attempts[1].ok, true);
  assert.deepEqual(attempted, ["wl-copy", "xclip"]);
});

await test("通道起不来（ENOENT）算失败并继续回落", async () => {
  const run = makeSpawn((bin) => (bin === "wl-copy" ? { error: new Error("spawn wl-copy ENOENT") } : { code: 0 }));
  const r = await copyToClipboard("x", {
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    platform: "linux",
    spawn: run.spawnFn,
    writeStdout: () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.tool, "xclip");
  assert.match(r.attempts[0].reason ?? "", /ENOENT/);
});

await test("卡住的通道按超时失败处理（杀进程），不会当成成功", async () => {
  const run = makeSpawn(() => ({ hang: true }));
  const r = await copyToClipboard("x", {
    env: { WAYLAND_DISPLAY: "wayland-0" },
    platform: "linux",
    spawn: run.spawnFn,
    timeoutMs: 15,
    writeStdout: () => {},
  });
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].ok, false);
  assert.equal(r.attempts[0].signal, "SIGKILL");
  assert.match(r.attempts[0].reason ?? "", /超时 15ms/);
  assert.equal(run.calls[0].killed, true);
  // 本地全挂 → OSC 52 兜底接手，所以最终 ok 为真，tool 标成 osc52
  assert.equal(r.tool, OSC52_TOOL);
});

await test("全通道失败 + OSC 52 超限 → ok:false，attempts 记录完整", async () => {
  const run = makeSpawn(() => ({ code: 127 }));
  const huge = "A".repeat(80_000); // base64 后 106672 字符，超 100000 上限
  assert.ok(Buffer.from(huge, "utf-8").toString("base64").length > 100_000);
  const r = await copyToClipboard(huge, {
    env: { DISPLAY: ":0" },
    platform: "linux",
    spawn: run.spawnFn,
    writeStdout: () => {
      throw new Error("超限时不该真写 OSC 52");
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.tool, null);
  assert.equal(r.osc52, false);
  assert.deepEqual(r.attempts.map((a) => [a.tool, a.ok, a.code, a.reason]), [
    ["xclip", false, 127, "退出码 127"],
    ["xsel", false, 127, "退出码 127"],
  ]);
});

await test("全通道失败（短文本）→ OSC 52 兜底触发，序列是 \\x1b]52;c;<base64>\\x07", async () => {
  const run = makeSpawn(() => ({ code: 1 }));
  const osc: string[] = [];
  const text = "无本地通道可用时的兜底";
  const r = await copyToClipboard(text, {
    env: { DISPLAY: ":0" },
    platform: "linux",
    spawn: run.spawnFn,
    writeStdout: (c) => osc.push(c),
  });
  assert.equal(r.ok, true);
  assert.equal(r.tool, OSC52_TOOL);
  assert.equal(r.osc52, true);
  assert.deepEqual(osc, [`\x1b]52;c;${Buffer.from(text, "utf-8").toString("base64")}\x07`]);
  assert.equal(r.attempts.length, 2);
});

await test("remote 会话（SSH/mosh）：本地成功也要发一次 OSC 52", async () => {
  for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"]) {
    const run = makeSpawn(() => ({ code: 0 }));
    const osc: string[] = [];
    const r = await copyToClipboard("远端也要拿到", {
      env: { WAYLAND_DISPLAY: "wayland-0", [key]: "1" },
      platform: "linux",
      spawn: run.spawnFn,
      writeStdout: (c) => osc.push(c),
    });
    assert.equal(r.ok, true);
    assert.equal(r.tool, "wl-copy");
    assert.equal(r.osc52, true, `${key} 下应额外发 OSC 52`);
    assert.equal(osc.length, 1);
  }
  assert.equal(isRemoteSession({ SSH_CONNECTION: "x" }), true);
  assert.equal(isRemoteSession({}), false);
});

await test("OSC 52 用注入的写出口：测试进程 stdout 零写入", async () => {
  const run = makeSpawn(() => ({ code: 1 }));
  const osc: string[] = [];
  const captured = await withStdoutSpy(async () => {
    await copyToClipboard("spy", {
      env: { DISPLAY: ":0" },
      platform: "linux",
      spawn: run.spawnFn,
      writeStdout: (c) => osc.push(c),
    });
  });
  assert.deepEqual(captured, [], "不该绕过注入直接写 process.stdout");
  assert.equal(osc.length, 1);
});

await test("emitOsc52 纯函数：超限返回 false 且不写", () => {
  const outs: string[] = [];
  assert.equal(emitOsc52("hi", (c) => outs.push(c)), true);
  assert.deepEqual(outs, [`\x1b]52;c;${Buffer.from("hi", "utf-8").toString("base64")}\x07`]);
  assert.equal(emitOsc52("A".repeat(80_000), (c) => outs.push(c)), false);
  assert.equal(outs.length, 1);
});

// ---------------------------------------------------------------------------
// describeClipboardResult：三种结局分开报
// ---------------------------------------------------------------------------

await test("本地工具成功：info 且带工具名", () => {
  const d = describeClipboardResult({ ok: true, tool: "wl-copy", attempts: [], osc52: false });
  assert.equal(d.level, "info");
  assert.ok(d.message.includes("wl-copy"), d.message);
});

await test("只发了 OSC 52：warning，且不说「已复制」", () => {
  const d = describeClipboardResult({ ok: true, tool: OSC52_TOOL, attempts: [], osc52: true });
  assert.equal(d.level, "warning");
  assert.equal(d.message.includes("已复制"), false, d.message);
});

await test("全失败：逐条带上通道与原因", () => {
  const d = describeClipboardResult({
    ok: false,
    tool: null,
    osc52: false,
    attempts: [
      { tool: "wl-copy", ok: false, code: 1, signal: null, reason: "退出码 1" },
      { tool: "xclip", ok: false, code: null, signal: "SIGKILL", reason: "超时 5000ms 未退出" },
    ],
  });
  assert.equal(d.level, "warning");
  assert.ok(d.message.includes("xclip: 超时 5000ms 未退出"), d.message);
});

console.log(failed === 0 ? "\n全部 PASS" : `\n${failed} 项 FAIL`);