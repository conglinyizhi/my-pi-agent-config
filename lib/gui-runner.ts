// lib/gui-runner.ts — 统一 GUI 启动器（Wails 版，替代 Electron spawn + 轮询）
//
// 两个入口：
//   runGuiWindow    — 启动并等待响应文件（gate/routing/editor 等需要结果的窗口）
//   launchGuiWindow — 只启动不等待（/subagent:gui 实时监视窗口，异步拉起后立即返回）
//
// runGuiWindow 用法：
//   import { runGuiWindow, findGuiBinary } from "#lib/gui-runner";
//   const r = await runGuiWindow("gate", { command, rules }, { timeoutMs: 120000, signal });
//   if (r.ok && r.data?.action === "allow") ...
//
// runGuiWindow 语义：
//   ok: true   — 读到响应文件（用户操作或窗口正常写出）
//   ok: false  — reason: "unavailable" 未找到 wails-gui / "spawn" 进程起不来 /
//                "timeout" 超时 / "aborted" 被中止 / "exited" 进程退出但无响应
//
// launchGuiWindow 语义：
//   写入 request.json → detached spawn → unref → 立即返回；临时目录在子进程 close/error 后清理。
//   ok: true   — spawn 成功（不等待任何响应）
//   ok: false  — reason: "unavailable" 未找到 wails-gui / "spawn" 进程创建失败

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 测试注入：替代 node:child_process 的 spawn */
export type GuiSpawnFn = (bin: string, args: string[], opts: SpawnOptions) => ChildProcess;

/** 测试注入：替代二进制查找（不传则用 findGuiBinary） */
export type GuiFindBinFn = () => string | null;

export interface GuiRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 测试注入：替代 node:child_process 的 spawn（不传则用真实 spawn） */
  spawnFn?: GuiSpawnFn;
  /** 测试注入：替代二进制查找（不传则用 findGuiBinary） */
  findBin?: GuiFindBinFn;
}

export interface GuiRunResult {
  ok: boolean;
  data?: any;
  /** "spawn" 表示子进程没起来（spawn 同步抛错或 emit 'error'），可回退到别的审批通道 */
  reason?: "timeout" | "aborted" | "exited" | "unavailable" | "spawn";
}

/** 查找 wails-gui 二进制（优先安装位，其次仓库构建位） */
export function findGuiBinary(): string | null {
  const candidates = [
    path.join(os.homedir(), ".pi", "agent", "bin", "wails-gui"),
    path.join(__dirname, "..", "wails-gui", "build", "bin", "wails-gui"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

export interface GuiLaunchOptions {
  /** 测试注入：替代 node:child_process 的 spawn（不传则用真实 spawn） */
  spawnFn?: GuiSpawnFn;
  /** 测试注入：替代二进制查找（不传则用 findGuiBinary） */
  findBin?: GuiFindBinFn;
}

export interface GuiLaunchResult {
  ok: boolean;
  reason?: "unavailable" | "spawn";
}

/**
 * 非阻塞启动一个 GUI 窗口：spawn 成功后立即返回，不等待 response.json / .ready /
 * 超时 / 窗口关闭。请求写入与 runGuiWindow 相同的私有临时目录模式，子进程退出
 * （close）或启动失败（error）时清理临时目录，绝不在子进程读取请求前删除。
 */
export function launchGuiWindow(
  windowName: string,
  request: unknown,
  opts: GuiLaunchOptions = {},
): GuiLaunchResult {
  const bin = (opts.findBin ?? findGuiBinary)();
  if (!bin) return { ok: false, reason: "unavailable" };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-${windowName}-`));
  const requestFile = path.join(tmpDir, "request.json");
  const responseFile = path.join(tmpDir, "response.json");
  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  };

  try {
    fs.writeFileSync(requestFile, JSON.stringify(request));
    const proc = (opts.spawnFn ?? spawn)(bin, [windowName, requestFile, responseFile], {
      stdio: "ignore",
      detached: true,
    });
    proc.unref();
    // 子进程已拿到 request 路径并退出后才清理；error 表示进程从未启动，同样清理
    proc.on("close", cleanup);
    proc.on("error", cleanup);
    return { ok: true };
  } catch {
    cleanup();
    return { ok: false, reason: "spawn" };
  }
}

/** 启动一个 GUI 窗口并等待响应文件（对齐原 Electron spawn + 300ms 轮询逻辑） */
export async function runGuiWindow(
  windowName: string,
  request: unknown,
  opts: GuiRunOptions = {},
): Promise<GuiRunResult> {
  const bin = (opts.findBin ?? findGuiBinary)();
  if (!bin) return { ok: false, reason: "unavailable" };

  const timeoutMs = opts.timeoutMs ?? 300_000;
  // timeoutMs <= 0 表示不设超时（依赖窗口退出/响应兜底），0 是明确语义而非立即超时
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-${windowName}-`));
  const requestFile = path.join(tmpDir, "request.json");
  const responseFile = path.join(tmpDir, "response.json");

  try {
    fs.writeFileSync(requestFile, JSON.stringify(request));

    // 结算装置先于 spawn 建好：'error' 监听必须紧跟着 spawn 挂上，
    // 挂晚了会让 ChildProcess 的未监听 'error' 直接抛穿当前进程
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let check: ReturnType<typeof setInterval> | null = null;
    let cleanupAbort: () => void = () => {};
    let resolveResult: (r: GuiRunResult) => void = () => {};
    const result = new Promise<GuiRunResult>((resolve) => {
      resolveResult = resolve;
    });
    // 任何一路结算都顺手把定时器和轮询收干净，不留挂着的定时器
    const finish = (r: GuiRunResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (check) clearInterval(check);
      cleanupAbort();
      resolveResult(r);
    };

    let proc: ChildProcess;
    try {
      proc = (opts.spawnFn ?? spawn)(bin, [windowName, requestFile, responseFile], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      // spawn 同步抛错（参数非法之类）：按「进程起不来」处理，交给上层回退
      return { ok: false, reason: "spawn" };
    }

    // 二进制存在但不可执行（EACCES）、路径失效（ENOENT）时 spawn 会 emit 'error'，
    // 无监听就是未捕获异常，会直接带走整个进程。这里按 reason:"spawn" 结算，不再等 close
    proc.on("error", () => {
      finish({ ok: false, reason: "spawn" });
    });

    // 'error' 可能同步触发（注入场景），已结算就不要再挂定时器
    if (settled) return await result;

    timeout = timeoutMs > 0
      ? setTimeout(() => {
          try { proc.kill("SIGTERM"); } catch {}
          finish({ ok: false, reason: "timeout" });
        }, timeoutMs)
      : null; // 不设超时：一直等到响应或进程退出

    check = setInterval(() => {
      try {
        const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
        finish({ ok: true, data });
      } catch {
        // response 还没写完，继续等
      }
    }, 300);

    proc.on("close", () => {
      // 已按 spawn 失败结算：close 后再补读 response 没有意义
      if (settled) return;
      // 进程退出：兜底读一次（窗口可能已写响应并退出）
      setTimeout(() => {
        try {
          const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
          finish({ ok: true, data });
        } catch {
          finish({ ok: false, reason: "exited" });
        }
      }, 100);
    });

    if (opts.signal) {
      const signal = opts.signal;
      const onAbort = () => {
        try { proc.kill("SIGTERM"); } catch {}
        finish({ ok: false, reason: "aborted" });
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbort = () => {
          try { signal.removeEventListener("abort", onAbort); } catch {}
        };
      }
    }

    return await result;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}
