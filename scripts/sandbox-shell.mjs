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
// 细粒度限制（subagent 场景，父进程注入 env，仅影响该子进程）：
//   PI_SANDBOX_RW=<dir>[:<dir>...]   可写根替换 cwd（subagent 只能写指定目录，其余只读）
//   PI_SANDBOX_READONLY=1            只读模式：不写 workspace（保留 /tmp /dev/null）
//
// 安全策略：fail-closed——landlock-run 缺失时拒绝执行并报错，绝不裸跑。
// 跨平台：仅 Linux（Landlock 内核机制）；macOS/Windows 不适用本 wrapper。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const VENDORED_LANDLOCK = join(AGENT_DIR, "scripts", "vendor", "landlock-run");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const FAIL_EXIT = 125;

function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** 直接执行 bash（豁免命令：完全权限开放） */
function execBash(command) {
  const res = spawnSync("bash", ["-c", command], { stdio: "inherit", cwd: process.cwd() });
  process.exit(res.status ?? 1);
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
      for (const dir of process.env.PI_SANDBOX_RW.split(":")) {
        if (dir) rw.push(dir);
      }
    } else {
      rw.push(process.cwd());
    }
  }
  const grants = ["--ro", "/"];
  for (const dir of rw) grants.push("--rw", dir);
  return grants;
}

/** 经 landlock-run 沙箱执行（bash 作为内层，解析照常） */
function execSandboxed(command, launcher) {
  const cwd = process.cwd();
  const res = spawnSync(launcher, [...buildGrants(), "--", "bash", "-c", command], {
    stdio: "inherit",
    cwd,
  });
  process.exit(res.status ?? 1);
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
//    其余平台或 PI_SANDBOX_DISABLE=1 → 直接透传 bash——沙箱在此"不适用"
//    而非"不可用"，绝不能 fail-closed 挂掉 pi 的所有 bash。
const platformSandboxed = process.platform === "linux" || process.platform === "darwin"
  || (process.platform === "win32" && process.env.PI_SANDBOX_WINDOWS === "1");
if (!platformSandboxed || process.env.PI_SANDBOX_DISABLE === "1") {
  execBash(command);
}

// 2. 豁免：settings.sandboxExempt 前缀命中 → 完全权限开放（用户显式配置，信任该命令）
const exempt = readSettings().sandboxExempt;
if (Array.isArray(exempt) && exempt.some((prefix) => command.trimStart().startsWith(prefix))) {
  execBash(command);
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
execSandboxed(command, launcher);
