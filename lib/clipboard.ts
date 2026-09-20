/**
 * lib/clipboard.ts — 跨平台剪贴板写入
 *
 * 设计要点（每条都对应一个实测过的坑，改动前先看完）：
 *
 * 1. 全程 spawn，不经过 shell：文本只从 stdin 进，不进命令行。
 *    旧实现把文本用单引号拼进 `sh -c`，而内容来源是 ~/.pi/talk-sleep.jsonl
 *    这种持久、外部可写的文件——是没有必要的注入面。
 *
 * 2. wl-copy 必须 await close 判 exit code === 0。wl-copy 会 fork 出持有
 *    selection 的 daemon，daemon 继承 stdio 管道，用 exec/execAsync 等不到管道 EOF
 *    （实测每次都精确卡到 3007/3005/3005 ms 才返回，"成功"信号其实来自超时定时器）。
 *    stdio 用 ["pipe","ignore","ignore"] + spawn 后 await close，实测 54ms 拿到真实退出码。
 *
 * 3. 所有工具都从 stdin 收文本，xclip/xsel 也一样。旧实现 `echo ... | xclip` 会多写
 *    一个尾换行（实测 wl-paste 读出 `PATH-B\n`）：同一份恢复指令尾部有无 \n 取决于
 *    机器上装了哪个工具，而有 \n 意味着「粘贴即回车执行」。
 *
 * 4. 按环境路由，不做无脑盲试（路由规则见 resolveChannels）。顺序试完四个工具既有
 *    假阳性（把 timeout 当成功），也是纯白等。
 *
 * 5. OSC 52 兜底：终端自己把 base64 写进宿主剪贴板。remote 会话（SSH/mosh）无论
 *    本地是否成功都要发一次——本地写的是远端那台机器的剪贴板，用户要的是本机的。
 *    官方 @earendil-works/pi-coding-agent 的 /copy 走的也是这条兜底路径。
 */

import { spawn } from "node:child_process";

/** 环境变量视图；默认取 process.env，测试可注入 */
export type ClipboardEnv = Record<string, string | undefined>;

/** 一条本地剪贴板通道 */
export interface ClipboardChannel {
  /** 工具名：状态栏提示、成功回报、失败原因前缀都用它 */
  tool: string;
  /** 可执行文件名（不经 shell，直接 spawn） */
  bin: string;
  args: string[];
}

/** 一次通道尝试的记录 */
export interface ClipboardAttempt {
  tool: string;
  ok: boolean;
  /** 退出码；spawn 直接失败（ENOENT 等）或超时被 kill 时为 null */
  code: number | null;
  /** 终止信号；正常退出为 null */
  signal: string | null;
  /** 失败原因（ok=true 时不带） */
  reason?: string;
}

export interface ClipboardResult {
  /** 是否至少有一条通道判定成功 */
  ok: boolean;
  /** 成功的通道名；仅 OSC 52 兜底成立时为 "osc52"；全失败为 null */
  tool: string | null;
  /** 逐通道尝试记录，顺序即路由顺序 */
  attempts: ClipboardAttempt[];
  /** 是否真的向 stdout 写了 OSC 52 序列（写了不代表终端一定认） */
  osc52: boolean;
}

/** 失败通道名：OSC 52 不是 spawn 出来的进程，单独占一个名字 */
export const OSC52_TOOL = "osc52";

/** stdin 写入的进程句柄（node:child_process 的 ChildProcess 结构上满足；只为注入留缝） */
export interface ClipboardProcess {
  stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", listener: (err: Error) => void): unknown };
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string): unknown;
}

export type ClipboardSpawn = (
  bin: string,
  args: string[],
  options: { stdio: ["pipe", "ignore", "ignore"]; env: ClipboardEnv },
) => ClipboardProcess;

export interface CopyToClipboardOptions {
  /** 环境视图，默认 process.env；同时决定路由与传给子进程的 env */
  env?: ClipboardEnv;
  /** 目标平台，默认 process.platform */
  platform?: string;
  /** spawn 实现，默认 node:child_process.spawn */
  spawn?: ClipboardSpawn;
  /** 每次尝试某条通道前回调（talk-sleep 用它更新状态栏） */
  onAttempt?: (tool: string) => void;
  /** OSC 52 写出目标，默认 process.stdout.write（测试注入以断言，不往测试进程 stdout 乱写） */
  writeStdout?: (chunk: string) => void;
  /** 单通道等待上限，默认 5000ms；超时按失败处理并杀进程（不会把卡住当成功） */
  timeoutMs?: number;
}

const DEFAULT_CHANNEL_TIMEOUT_MS = 5000;

/** OSC 52 payload 上限（base64 字符数）：再大有些终端会渲染错乱，官方实现取同一个数 */
const MAX_OSC52_ENCODED_LENGTH = 100_000;

/**
 * 按平台/环境算出要依次尝试的通道顺序（纯函数，便于单测）。
 *
 * - darwin            → pbcopy
 * - win32             → clip
 * - linux + Termux    → termux-clipboard-set
 * - linux + Wayland   → wl-copy（失败且 DISPLAY 存在则回落 xclip → xsel）
 * - linux + 仅 DISPLAY → xclip → xsel
 * - 其它 / 无图形环境  → 空列表，交给 OSC 52 兜底
 */
export function resolveChannels(env: ClipboardEnv, platform: string = process.platform): ClipboardChannel[] {
  if (platform === "darwin") return [{ tool: "pbcopy", bin: "pbcopy", args: [] }];
  if (platform === "win32") return [{ tool: "clip", bin: "clip", args: [] }];
  if (platform !== "linux") return [];

  const channels: ClipboardChannel[] = [];
  if (env.TERMUX_VERSION) channels.push({ tool: "termux-clipboard-set", bin: "termux-clipboard-set", args: [] });
  if (env.WAYLAND_DISPLAY) channels.push({ tool: "wl-copy", bin: "wl-copy", args: [] });
  if (env.DISPLAY) {
    channels.push({ tool: "xclip", bin: "xclip", args: ["-selection", "clipboard"] });
    channels.push({ tool: "xsel", bin: "xsel", args: ["--clipboard", "--input"] });
  }
  return channels;
}

/** 是否 remote 会话：SSH/mosh 下本地剪贴板写的是远端那台机器 */
export function isRemoteSession(env: ClipboardEnv = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

/**
 * 写 OSC 52 序列。返回是否真的发出（payload 超上限则放弃）。
 * 纯函数风格：写出口由调用方给，测试可以只收字符串。
 */
export function emitOsc52(text: string, write: (chunk: string) => void): boolean {
  const encoded = Buffer.from(text, "utf-8").toString("base64");
  if (encoded.length > MAX_OSC52_ENCODED_LENGTH) return false;
  write(`\x1b]52;c;${encoded}\x07`);
  return true;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * 跑一条通道：文本写入 stdin，等 close 拿退出码。
 * 不用 race 把"卡住"当成功——超时是失败，并且杀进程。
 */
function runChannel(
  spawnFn: ClipboardSpawn,
  channel: ClipboardChannel,
  text: string,
  env: ClipboardEnv,
  timeoutMs: number,
): Promise<Omit<ClipboardAttempt, "tool">> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (result: Omit<ClipboardAttempt, "tool">) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let proc: ClipboardProcess;
    try {
      proc = spawnFn(channel.bin, channel.args, { stdio: ["pipe", "ignore", "ignore"], env });
    } catch (e) {
      done({ ok: false, code: null, signal: null, reason: `无法启动 ${channel.bin}: ${errorMessage(e)}` });
      return;
    }

    proc.on("error", (err: Error) => {
      done({ ok: false, code: null, signal: null, reason: `无法启动 ${channel.bin}: ${err.message}` });
    });
    proc.on("close", (code: number | null, signal: string | null) => {
      if (code === 0) done({ ok: true, code, signal });
      else done({ ok: false, code, signal, reason: signal ? `被信号 ${signal} 终止` : `退出码 ${code}` });
    });
    // 工具提前退出（如 wl-copy 连不上 compositor）时 stdin 会 EPIPE；结果由 close 判定
    proc.stdin.on("error", () => {});

    try {
      proc.stdin.write(text);
      proc.stdin.end();
    } catch (e) {
      done({ ok: false, code: null, signal: null, reason: `写入 stdin 失败: ${errorMessage(e)}` });
      return;
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // 进程可能已经退出，kill 失败不影响判定
        }
        done({ ok: false, code: null, signal: "SIGKILL", reason: `超时 ${timeoutMs}ms 未退出` });
      }, timeoutMs);
    }
  });
}

/**
 * 复制文本到剪贴板。
 *
 * 依次尝试 resolveChannels 给出的本地通道（每条前回调 onAttempt）；
 * 全部失败、或处于 remote 会话时，追加一次 OSC 52 兜底。
 */
export async function copyToClipboard(text: string, opts: CopyToClipboardOptions = {}): Promise<ClipboardResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const spawnFn = opts.spawn ?? (spawn as unknown as ClipboardSpawn);
  const writeStdout = opts.writeStdout ?? ((chunk: string) => { process.stdout.write(chunk); });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS;

  const attempts: ClipboardAttempt[] = [];
  let tool: string | null = null;

  for (const channel of resolveChannels(env, platform)) {
    opts.onAttempt?.(channel.tool);
    const result = await runChannel(spawnFn, channel, text, env, timeoutMs);
    attempts.push({ tool: channel.tool, ...result });
    if (result.ok) {
      tool = channel.tool;
      break;
    }
  }

  const remote = isRemoteSession(env);
  const osc52 = tool === null || remote ? emitOsc52(text, writeStdout) : false;

  if (tool !== null) return { ok: true, tool, attempts, osc52 };
  if (osc52) return { ok: true, tool: OSC52_TOOL, attempts, osc52: true };
  return { ok: false, tool: null, attempts, osc52: false };
}

/**
 * 把一次复制的结果翻成给用户看的一句话。
 *
 * 三种结局必须分开报，尤其后两种不能合并（合并过一次：把 OSC 52 当成功报「已复制」，
 * 用户粘不出来又不知道差在哪）：
 *  - 本地工具退出码 0 → 真的写进去了
 *  - 只发了 OSC 52 → 序列发出去了，但终端认不认由终端决定
 *  - 全失败 → 逐条带上失败原因，用户才知道缺哪个工具
 *
 * 纯函数，不碰 UI：调用方自己决定往哪报（notify / 状态栏 / 日志）。
 */
export function describeClipboardResult(result: ClipboardResult): { level: "info" | "warning"; message: string } {
  if (result.ok && result.tool !== OSC52_TOOL) {
    return { level: "info", message: `已复制到剪贴板（${result.tool}）` };
  }
  if (result.ok) {
    return {
      level: "warning",
      message: "已通过 OSC 52 发给终端，能否生效取决于终端是否支持。粘不到就手动复制",
    };
  }
  const failures = result.attempts.filter((a) => !a.ok);
  const detail =
    failures.length > 0
      ? `\n尝试了 ${failures.length} 个工具均失败：\n${failures.map((a) => `  · ${a.tool}: ${a.reason ?? "未知错误"}`).join("\n")}`
      : "";
  return { level: "warning", message: `复制失败，没找到可用的剪贴板工具${detail}` };
}
