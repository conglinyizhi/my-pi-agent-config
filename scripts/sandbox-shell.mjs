#!/usr/bin/env node
// sandbox-shell.mjs — pi bash 工具的自定义 shell（settings.json 的 shellPath）
//
// 把每条 bash 命令包进 Landlock 内核文件系统沙箱（vendored landlock-run）：
//   grants: --ro /（全系统只读）+ --rw /tmp --rw /dev/null --rw <cwd>（工作区可写）
//   未授权的写入由内核 EROFS 拒绝 → 模型无法改工作区之外的文件，无需逐条审批
//
// 配置（settings.json，经 settings-sync 同步 tracked）：
//   "shellPath": "~/.pi/agent/scripts/sandbox-shell.mjs"  启用本沙箱
//   "sandboxExempt": ["git push", "npm publish"]           前缀命中 → 完全权限开放（不沙箱）
//   环境变量 LANDLOCK_RUN 可覆盖 landlock-run 路径（默认仓库 scripts/vendor/landlock-run）
//
// 细粒度限制（父进程注入 env，仅影响该子进程）：
//   PI_SANDBOX_RW=<dir>[:<dir>...]       可写根替换 cwd（subagent 只能写指定目录，其余只读）
//   PI_SANDBOX_READONLY=1                只读模式：不写 workspace（保留 /tmp /dev/null）
//   PI_SANDBOX_RW_EXTRA=<dir>[:<dir>...] 额外可写根，叠加在默认 cwd 之上（sandbox-allow 一次性升权用）
//   PI_SANDBOX_DISABLE=1                 文件系统沙箱完全开放，直接透传 bash（一次性升权 / 逃生门）
//
// 内存限制（与文件系统沙箱正交，独立维度）：
//   PI_SANDBOX_MEMORY_MB=<整数>          单条命令进程树的内存上限（MB）。缺省 1GiB（DEFAULT_MEMORY_MB）。
//                                        由 sandbox-allow 的 memoryMb 参数注入：大模型需给出具体数字才能提升。
//                                       未提供时所有 bash 命令默认按 1GiB 上限执行。
//   PI_SANDBOX_MEMORY_DISABLE=1          关闭内存墙（/yolo 全降零时由 spawnHook 注入；不设则内存墙照常生效）。
//
// 内存墙实现：进程树匿名内存（/proc/<pid>/status 的 RssAnon，私有匿名页=真实堆分配）采样。
// 选用 RssAnon 而非 VmRSS：避免整棵进程树里共享库被逐进程重复计数导致的误杀
// （多进程构建如 make -j 会常见）。超限 → SIGKILL 整棵进程组，退出码 137（128+SIGKILL）。
// 仅 Linux（/proc 存在）；macOS/Windows 无 /proc 时采样恒为 0，内存墙自动失效（不误杀、不报错）。
//
// 安全策略：fail-closed——landlock-run 缺失时拒绝执行并报错，绝不裸跑。
// 跨平台：仅 Linux（Landlock 内核机制）；macOS/Windows 不适用本 wrapper。

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const VENDORED_LANDLOCK = join(AGENT_DIR, "scripts", "vendor", "landlock-run");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const FAIL_EXIT = 125;

// ── 内存墙常量 ──
const DEFAULT_MEMORY_MB = 1024;    // 默认 1GiB
const MAX_MEMORY_MB = 32 * 1024;   // 防御性上限 32GiB（沙盒层钳制；正常上限由 helpers.ts 统一约束）
const MEMORY_POLL_MS = 500;        // 采样周期（毫秒）
const OOM_EXIT = 137;              // 128 + SIGKILL，标识内存超限被终止

function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

/**
 * 读目录白名单 allowDirs（extensions/sandbox-permissions/sandbox-paths.json）。
 * 主 agent 的 bash 沙盒把这些目录作为常驻 `--rw` 可写根，免走 sandbox-allow 一次授权。
 * 读失败 / 不存在 → []；过滤空串与非绝对路径，拒绝根目录 `/`（避免 --rw / 覆盖 --ro /）。
 */
function readAllowDirs() {
  try {
    const doc = JSON.parse(
      readFileSync(join(AGENT_DIR, "extensions", "sandbox-permissions", "sandbox-paths.json"), "utf8"),
    );
    const list = Array.isArray(doc.allowDirs) ? doc.allowDirs : [];
    return list
      .filter((d) => typeof d === "string" && d)
      .map((d) => {
        if (d === "~") return homedir();
        if (d.startsWith("~/")) return join(homedir(), d.slice(2));
        return d;
      })
      .map((d) => normalize(d))
      .filter((d) => d !== "/" && d.startsWith("/"));
  } catch {
    return [];
  }
}

/**
 * 解析单条命令的内存上限（MB）。返回 0 = 不限制（/yolo 关闭内存墙）。
 *   PI_SANDBOX_MEMORY_DISABLE=1 → 0（关闭）
 *   PI_SANDBOX_MEMORY_MB 为正整数 → 取该值与 MAX 的较小者
 *   缺省 → DEFAULT_MEMORY_MB
 */
function resolveMemoryMB() {
  if (process.env.PI_SANDBOX_MEMORY_DISABLE === "1") return 0;
  const raw = parseInt(process.env.PI_SANDBOX_MEMORY_MB ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, MAX_MEMORY_MB);
  return DEFAULT_MEMORY_MB;
}

/** 读单进程匿名内存（RssAnon，kB）。进程不存在返回 0。 */
function readRssAnonKb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /^RssAnon:\s+(\d+)\s+kB$/m.exec(status);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

/** 读进程的直接子进程 pid 列表（/proc/<pid>/task/<pid>/children）。 */
function childPids(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    return text ? text.split(/\s+/).map(Number).filter((n) => n > 0) : [];
  } catch {
    return [];
  }
}

/** 递归累加 pid 及其所有后代进程的匿名内存（kB）。子进程已不存在时贡献 0，安全。 */
function treeRssAnonKb(pid) {
  if (!pid || pid <= 0) return 0;
  let total = readRssAnonKb(pid);
  for (const child of childPids(pid)) total += treeRssAnonKb(child);
  return total;
}

/**
 * 以异步 spawn 方式执行一条命令并阻塞等待退出，附带可选的内存墙监控。
 *   1. detached:true → 子进程成为进程组组长；超限时 `process.kill(-pid)` 可整棵终止进程树。
 *   2. 采样进程树匿名内存；超过上限 → 打印原因、SIGKILL 整组、以 OOM_EXIT(137) 退出。
 *   3. 正常退出按子进程 exit code 透传；启动失败（error 事件）以 FAIL_EXIT 退出。
 */
function runCommand(launcher, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(launcher, args, { stdio: "inherit", cwd, detached: true });
    const memMb = resolveMemoryMB();
    let oomKilled = false;
    let poll;

    const checkMem = () => {
      if (memMb <= 0 || oomKilled) return;
      if (treeRssAnonKb(child.pid || 0) > memMb * 1024) {
        oomKilled = true;
        console.error(
          `sandbox-shell: 命令进程树匿名内存超出上限（${memMb} MB），已终止进程组：${(args[args.length - 1] ?? "").slice(0, 120)}`,
        );
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* 进程组已退出，忽略 */
        }
      }
    };

    if (memMb > 0) {
      // 启动瞬间与周期采样双保险：短命但瞬态超限的命令也能触发。
      setImmediate(checkMem);
      poll = setInterval(checkMem, MEMORY_POLL_MS);
    }

    child.on("error", (err) => {
      if (poll) clearInterval(poll);
      console.error(`sandbox-shell: 无法启动命令：${err.message}`);
      process.exit(FAIL_EXIT);
    });
    child.on("exit", (code, signal) => {
      if (poll) clearInterval(poll);
      // 我们自己触发的内存超限 → 用统一 OOM_EXIT；其余情况透传子进程状态。
      if (oomKilled) process.exit(OOM_EXIT);
      process.exit(code ?? (signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : 1));
    });
  });
}

/** 直接执行 bash（豁免命令 / 非沙箱平台 / 完全开放：文件系统不沙箱，但内存墙照常） */
function execBash(command) {
  return runCommand("bash", ["-c", command], process.cwd());
}

/**
 * 细粒度 grants 构造：
 *   默认：--ro / + --rw /tmp /dev/null <cwd>（写工作区）
 *   PI_SANDBOX_RW=<dir>[:…]：可写根替换 cwd（subagent 只写指定目录，工程其余只读）
 *   PI_SANDBOX_READONLY=1：只读模式，不写 workspace（/tmp /dev/null 保留作临时文件）
 */
function buildGrants() {
  const rw = ["/tmp", "/dev/null"];
  if (process.env.PI_SANDBOX_READONLY !== "1") {
    if (process.env.PI_SANDBOX_RW) {
      // subagent：只能写指定的 sandboxDir，工程其余只读——保持隔离，不叠加白名单
      for (const dir of process.env.PI_SANDBOX_RW.split(":")) {
        if (dir) rw.push(dir);
      }
    } else {
      rw.push(process.cwd());
      // 主 agent 默认：白名单目录（sandbox-paths.json 的 allowDirs）作为常驻可写根，
      // bash 可直接写这些目录，免走 sandbox-allow 一次授权
      for (const dir of readAllowDirs()) {
        if (dir && !rw.includes(dir)) rw.push(dir);
      }
    }
  }
  // 一次性升权：额外可写根，叠加在默认 cwd 之上（sandbox-allow 注入 PI_SANDBOX_RW_EXTRA）
  if (process.env.PI_SANDBOX_RW_EXTRA) {
    for (const dir of process.env.PI_SANDBOX_RW_EXTRA.split(":")) {
      if (dir) rw.push(dir);
    }
  }
  const grants = ["--ro", "/"];
  for (const dir of rw) grants.push("--rw", dir);
  return grants;
}

/** 经 landlock-run 沙箱执行（bash 作为内层，解析照常） */
function execSandboxed(command, launcher) {
  return runCommand(launcher, [...buildGrants(), "--", "bash", "-c", command], process.cwd());
}

// ── 入口 ──
const args = process.argv.slice(2);
if (args[0] !== "-c" || args.length < 2) {
  console.error("sandbox-shell: 仅支持 -c <command> 调用（pi shellPath 契约）");
  process.exit(FAIL_EXIT);
}
const command = args.slice(1).join(" ");

// 1. 平台守卫：Linux → Landlock、darwin → Seatbelt（sandbox-exec）。
//    Windows → 受限令牌+ACL runner 已实现但未真机验证，默认透传；
//    显式 PI_SANDBOX_WINDOWS=1 才启用（真机验证通过前保持默认安全）。
//    其余平台或 PI_SANDBOX_DISABLE=1 → 直接透传 bash——文件系统沙箱在此"不适用"
//    而非"不可用"，绝不能 fail-closed 挂掉 pi 的所有 bash。内存墙与文件系统沙箱正交，
//    透传时照常生效（除非 PI_SANDBOX_MEMORY_DISABLE=1）。
const platformSandboxed = process.platform === "linux" || process.platform === "darwin"
  || (process.platform === "win32" && process.env.PI_SANDBOX_WINDOWS === "1");
if (!platformSandboxed || process.env.PI_SANDBOX_DISABLE === "1") {
  await execBash(command);
}

// 2. 豁免：settings.sandboxExempt 前缀命中 → 文件系统完全权限开放（用户显式配置，信任该命令）；
//    内存墙仍生效。
const exempt = readSettings().sandboxExempt;
if (Array.isArray(exempt) && exempt.some((prefix) => command.trimStart().startsWith(prefix))) {
  await execBash(command);
}

// 3. fail-closed：landlock-run 必须存在
const launcher = process.env.LANDLOCK_RUN || VENDORED_LANDLOCK;
if (!existsSync(launcher)) {
  console.error(
    `sandbox-shell: 找不到 landlock-run（${launcher}）。已 fail-closed 拒绝执行：${command.slice(0, 120)}`,
  );
  process.exit(FAIL_EXIT);
}

// 4. 沙箱执行
await execSandboxed(command, launcher);
