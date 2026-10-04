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
// 网络限制（与文件系统沙箱正交，独立维度）：
//   PI_SANDBOX_NET=block                  内核层断网（seccomp 拦 socket(AF_INET/AF_INET6)）
//   PI_SANDBOX_NET=allow                  本条命令不带断网层（已获批 network capability 的命令走这条）
//   未设时 worker（PI_SUBAGENT=1）按 block，主 agent 不拦（主 agent 的网络判断在工具层，
//   不做 OS 级隔离）。网络墙与审核链是纵深关系：审核链决定「哪条命令可以出网」，
//   seccomp 层保证「没走通审核的命令即使审核判漏了也真连不上」。
//
// 文件系统读（worker）：landlock 是 allow-list，`--ro /` 会把全盘授读。worker 处理的是不可信
// 内容，读面就是潜在的外传源，所以它的 --ro 换成白名单（系统路径 + 工具链 + cwd，见 workerReadRoots）。
// 主 agent 不受影响（仍为 --ro /）。
//
// 资源限制（与文件系统 / 网络沙箱正交，独立维度；采样式，与内存墙同一套机制）：
//   PI_SANDBOX_MEMORY_MB=<整数>          进程树匿名内存上限（MB）。缺省 1GiB（worker 与主 agent 同）。
//                                        由 sandbox-allow 的 memoryMb 参数注入（大模型须给具体数字才能提额）。
//   PI_SANDBOX_NPROC=<整数>              进程树进程数上限（含自身）。缺省：worker 128，主 agent 不限。
//   PI_SANDBOX_WRITE_MB=<整数>           写盘上限（MB）。按受监控可写根所在文件系统的已用空间增量
//                                        采样（不是进程 write_bytes：那条只算活着的进程，
//                                        循环 dd / tmpfs 写入都漏）。缺省：worker 2048（2GiB），主 agent 不限。
//   三者给 0 或对应 *_DISABLE=1 → 关闭该项（/yolo 全降零同样走 DISABLE）。
//
// 资源墙实现：匿名内存（/proc/<pid>/status 的 RssAnon，私有匿名页=真实堆分配）、进程数、
// 累计写入三项采样。选用 RssAnon 而非 VmRSS：避免整棵进程树里共享库被逐进程重复计数
// 导致的误杀（多进程构建如 make -j 会常见）。超限 → SIGKILL 整棵进程组，退出码 137
// （128+SIGKILL）。仅 Linux（/proc 存在）；macOS/Windows 无 /proc 时采样恒为 0，这些
// 限制自动失效（不误杀、不报错）。
//
// 安全策略：fail-closed——landlock-run 缺失时拒绝执行并报错，绝不裸跑。
// 跨平台：仅 Linux（Landlock 内核机制）；macOS/Windows 不适用本 wrapper。
//
// 网络：worker 默认挂 seccomp 网络墙（scripts/network-block-run.c），只有 capability
// 批过的命令带 PI_SANDBOX_NET=allow 放行；主 agent 不挂。审核链决定「谁可以出网」，
// 网络墙保证「没走通审核的命令真连不上」——两层是纵深，不是替代。
// 历史：2026-09-06 首次接入，2026-09-13 因审核链接手而移除，2026-10-01 作为
// 「防注入外传」的兜底接回（那之前「审核判漏的命令」是可以直接联网的）。

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, statfsSync } from "node:fs";
import { join, normalize } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const VENDORED_LANDLOCK = join(AGENT_DIR, "scripts", "vendor", "landlock-run");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const FAIL_EXIT = 125;

// ── 资源墙常量 ──
const DEFAULT_MEMORY_MB = 1024;    // 默认 1GiB
const MAX_MEMORY_MB = 32 * 1024;   // 防御性上限 32GiB（沙盒层钳制；正常上限由 helpers.ts 统一约束）
const DEFAULT_WORKER_NPROC = 128;  // worker 进程树进程数上限（make -j / pnpm 并发都够）
const DEFAULT_WORKER_WRITE_MB = 2048; // worker 进程树累计写入上限（2GiB）
const MAX_WRITE_MB = 32 * 1024;
const MEMORY_POLL_MS = 500;        // 采样周期（毫秒），三项限制共用
const OOM_EXIT = 137;              // 128 + SIGKILL，标识资源超限被终止
const VENDORED_NETWORK_BLOCK = join(AGENT_DIR, "scripts", "vendor", "network-block-run"); // seccomp 网络墙（worker 默认）

/** 本条命令是否挂了网络墙（给退出提示用；单命令进程，模块级变量够） */
let netBlockedThisRun = false;

/**
 * 非零退出时补的一行指路。
 *
 * 目的：撞沙箱墙（「权限不够 / 只读文件系统」）看起来就像普通权限问题，
 * agent 容易去试 sudo、或者反复重试同一条命令，实际都白费。
 * 这句把「下一步该干什么」直接摊在报错旁边，不指望 agent 去翻提示词。
 *
 * 措辞用条件句（“若是权限问题”）：命令自己的非零退出也会走到这里，
 * 不能把「你被沙箱拦了」说成事实。
 *
 * 内存上限写实际值：这条命令可能被 sandbox-allow 提过额度（memoryMb），
 * 嘴硬说“1GiB”会让人照着那个数去猜。
 */
function sandboxHint(limits, netBlocked) {
  const lines = [
    "（若是权限问题）这条命令跑在文件系统沙箱里：只能写工作目录、/tmp、/dev/null。",
    "写别处要用 sandbox-allow 申请（permission=write-paths + 最小 paths + 一句 justification），sudo 解决不了。",
  ];
  if (netBlocked) {
    // 断网失败的报错（ECONNREFUSED / EPERM）不像权限问题，容易被当成目标服务挂了
    lines.push("这条命令同时跑在内核级断网里：worker 的 bash 默认不带网（seccomp 拦 socket）。需要出网的命令要走 capability 审批，获批后才带网。");
  }
  if (workerReadScoped()) {
    lines.push("worker 的读面是白名单（系统目录 + 工具链 + 工作目录）；要读白名单外的路径，就把该目录通过派工参数加进来。");
  }
  lines.push(
    `命令资源上限：内存 ${limits.memoryMb > 0 ? `${limits.memoryMb} MB` : "不限"}、进程 ${limits.nproc > 0 ? limits.nproc : "不限"}、累计写盘 ${limits.writeMb > 0 ? `${limits.writeMb} MB` : "不限"}。内存不够就用 sandbox-allow 的 memoryMb 给具体数值。`,
    "不要为绕过沙箱而改写命令或反复重试同一条。",
  );
  return lines.join("\n");
}

/** 沙箱是否被整体关掉（关掉时那句指路就是噪音） */
function sandboxDisabled() {
  return process.env.PI_SANDBOX_DISABLE === "1";
}

const STOP_GRACE_MS = 1500;        // 收到终止信号后，留给命令自己收尾的时间；超时 SIGKILL 整组

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
/**
 * 解析本条命令的资源上限。
 *   内存：*_DISABLE=1 → 0；给正整数 → 取该值与 MAX 的较小者；缺省 DEFAULT_MEMORY_MB。
 *   进程数 / 写盘：显式给数才开（主 agent 默认不限）；worker 缺省走下面两个 worker 默认值。
 */
function resolveLimits() {
  const isWorker = process.env.PI_SUBAGENT === "1";
  const memRaw = parseInt(process.env.PI_SANDBOX_MEMORY_MB ?? "", 10);
  const memoryMb = process.env.PI_SANDBOX_MEMORY_DISABLE === "1"
    ? 0
    : (Number.isFinite(memRaw) && memRaw > 0 ? Math.min(memRaw, MAX_MEMORY_MB) : DEFAULT_MEMORY_MB);

  const nprocRaw = parseInt(process.env.PI_SANDBOX_NPROC ?? "", 10);
  const nproc = process.env.PI_SANDBOX_NPROC_DISABLE === "1"
    ? 0
    : (Number.isFinite(nprocRaw) && nprocRaw > 0 ? nprocRaw : (isWorker ? DEFAULT_WORKER_NPROC : 0));

  const writeRaw = parseInt(process.env.PI_SANDBOX_WRITE_MB ?? "", 10);
  const writeMb = process.env.PI_SANDBOX_WRITE_DISABLE === "1"
    ? 0
    : (Number.isFinite(writeRaw) && writeRaw > 0 ? Math.min(writeRaw, MAX_WRITE_MB) : (isWorker ? DEFAULT_WORKER_WRITE_MB : 0));

  return { memoryMb, nproc, writeMb };
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

/** 进程树进程数（含 pid 自身）。子进程已退出时不计，安全。 */
function treeProcCount(pid) {
  if (!pid || pid <= 0) return 0;
  let count = 1;
  for (const child of childPids(pid)) count += treeProcCount(child);
  return count;
}

/**
 * 受监控路径所在文件系统的已用空间（字节）。
 *
 * 为什么不用 /proc/<pid>/io 的 write_bytes：那条路只统计**当前还活着**的进程，
 * 而「写满盘」的典型形态恰恰是「起一个进程写一坨、退出、再起一个」（循环 dd、构建产物分片），
 * 采样时子进程早没了；tmpfs（本机 /tmp）的写入更是压根不计入 write_bytes。
 * 实测（2026-10-01）：循环往 /tmp 写 25MB，write_bytes 一路为 0，那堵墙形同虚设。
 *
 * 换成文件系统用量后：不管是谁写的、进程还在不在，用量都在账上（tmpfs 也算）。
 * 同一文件系统按设备号去重（多个可写根可能落在同一个 fs 上）。
 * 代价是它统计的是**整个文件系统**的增量——同机上别人同时在写会算进来；
 * 阈值给得够大（worker 默认 2GiB）时这不构成实际误伤。
 */
function fsUsageSnapshot(paths) {
  const byDevice = new Map();
  for (const p of paths) {
    try {
      const dev = statSync(p).dev;
      if (byDevice.has(dev)) continue;
      const st = statfsSync(p);
      byDevice.set(dev, (st.blocks - st.bfree) * st.bsize);
    } catch {
      /* 路径不存在 / 读不到：跳过这条 */
    }
  }
  let total = 0;
  for (const used of byDevice.values()) total += used;
  return total;
}

/** 从 landlock grants 里取出可写根（写盘墙只盯真正能写的地方，/dev/null 不算） */
function writableRootsOf(grants) {
  const roots = [];
  for (let i = 0; i + 1 < grants.length; i++) {
    if (grants[i] === "--rw") roots.push(grants[i + 1]);
  }
  return roots.filter((p) => p !== "/dev/null");
}

/**
 * 以异步 spawn 方式执行一条命令并阻塞等待退出，附带可选的内存墙监控。
 *   1. detached:false → 命令留在**我们自己的进程组**里。pi 起我们时用了 detached
 *      （sandbox-shell 是组长），它们才收得住：abort/超时是 `kill(-我们的pid, SIGKILL)`，
 *      命令若自成一个组就逃过这一刀，变成孤儿继续跑（2026-09-30 实测：bash_background
 *      任务被取消后 sleep 仍活着，因为它在另一个进程组里）。
 *   2. 采样三项资源（匿名内存 / 进程数 / 累计写入）；任一超限 → 打印原因、SIGKILL 整组、
 *      以 OOM_EXIT(137) 退出。
 *   3. 正常退出按子进程 exit code 透传；启动失败（error 事件）以 FAIL_EXIT 退出。
 */
function runCommand(launcher, args, cwd, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(launcher, args, { stdio: "inherit", cwd, detached: false });
    const limits = resolveLimits();
    const watchPaths = opts.watchPaths ?? [];
    // 写盘基线在 spawn 之后立刻取：只算这条命令跑起来之后的增量
    const writeBaseline = limits.writeMb > 0 ? fsUsageSnapshot(watchPaths) : 0;
    const limited = limits.memoryMb > 0 || limits.nproc > 0 || limits.writeMb > 0;
    let limitKilled = null;
    let poll;

    /** 三项资源共用一次采样：哪项先超就报哪项 */
    const checkLimits = () => {
      if (limitKilled || !child.pid) return;
      const pid = child.pid;
      if (limits.memoryMb > 0 && treeRssAnonKb(pid) > limits.memoryMb * 1024) {
        limitKilled = `匿名内存超出上限（${limits.memoryMb} MB）`;
      } else if (limits.nproc > 0 && treeProcCount(pid) > limits.nproc) {
        limitKilled = `进程数超出上限（${limits.nproc}）`;
      } else if (limits.writeMb > 0) {
        const grownMb = Math.round((fsUsageSnapshot(watchPaths) - writeBaseline) / (1024 * 1024));
        if (grownMb > limits.writeMb) limitKilled = `写盘超出上限（${limits.writeMb} MB）`;
      }
      if (!limitKilled) return;
      console.error(
        `sandbox-shell: 命令进程树${limitKilled}，已终止进程组：${(args[args.length - 1] ?? "").slice(0, 120)}`,
      );
      // 组杀会连自己一起带走，退出码就是 137（128+SIGKILL）= OOM_EXIT，不用再 exit
      killGroup("SIGKILL");
    };

    if (limited) {
      // 启动瞬间与周期采样双保险：短命但瞬态超限的命令也能触发。
      setImmediate(checkLimits);
      poll = setInterval(checkLimits, MEMORY_POLL_MS);
    }

    /**
     * 终止整条命令链。命令与我们同组、组长是我们（pi 用 detached 起我们），
     * `-process.pid` 一下带走全体；万一我们不是组长（被别的调用方当库用），
     * `-pid` 会 ESRCH，退化为只杀直接子进程。
     */
    const killGroup = (signal) => {
      try {
        process.kill(-process.pid, signal);
      } catch {
        try {
          process.kill(child.pid, signal);
        } catch {
          /* 都退出了，忽略 */
        }
      }
    };

    // 父进程（pi）终止我们时信号要传到命令。pi 的 abort 走 killProcessTree（组杀 SIGKILL）
    // 已覆盖；这个 handler 是给「有人只 SIGTERM 我们」的场景兜底的。
    let stopping = false;
    for (const [signal, code] of [
      ["SIGTERM", 143],
      ["SIGINT", 130],
      ["SIGHUP", 129],
      ["SIGQUIT", 131],
    ]) {
      process.on(signal, () => {
        if (stopping) return; // 连发多次信号只处理第一发
        stopping = true;
        if (poll) clearInterval(poll);
        killGroup(signal);
        // 不 unref：这段时间正是等命令收尾，进程要活着
        setTimeout(() => {
          killGroup("SIGKILL");
          process.exit(code);
        }, STOP_GRACE_MS);
      });
    }

    child.on("error", (err) => {
      if (poll) clearInterval(poll);
      console.error(`sandbox-shell: 无法启动命令：${err.message}`);
      process.exit(FAIL_EXIT);
    });
    child.on("exit", (code, signal) => {
      if (poll) clearInterval(poll);
      // 我们自己触发的资源超限 → 用统一 OOM_EXIT；其余情况透传子进程状态。
      if (limitKilled) process.exit(OOM_EXIT);
      const exitCode = code ?? (signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : 1);
      // 非零退出时补一行指路。不区分「是不是沙箱拦的」——判不准，而且判错的代价
      // （命令自己报错却被说成沙箱）只是多一句废话，漏报的代价是 agent 卡在
      // 一条根本没有报错的死路上。措辞用条件句，退出码一字不改地透传。
      if (exitCode !== 0 && !sandboxDisabled()) {
        console.error(sandboxHint(limits, netBlockedThisRun));
      }
      process.exit(exitCode);
    });
  });
}

/**
 * 读 worker 只读根白名单（extensions/sandbox-permissions/worker-read-roots.json）。
 * 与工具层（guard.ts）共用同一份：bash 用 landlock、工具用路径判定，口径必须一致，
 * 否则 worker 会「bash 读得到、read 工具读不到」。读不到 / 解析失败 → []（用内置默认）。
 */
function readWorkerReadRoots() {
  try {
    const doc = JSON.parse(
      readFileSync(join(AGENT_DIR, "extensions", "sandbox-permissions", "worker-read-roots.json"), "utf8"),
    );
    const list = Array.isArray(doc.roots) ? doc.roots : [];
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
 * worker 的只读根白名单（bash 层读面）。
 *
 * 主 agent 的 grants 里 `--ro /` 把整个文件系统授读；worker 读的是不可信内容
 * （三方仓库、网页、issue），读面就是待防的外传源：会话历史、提督的笔记、其它项目。
 * 这里换成白名单：系统路径 + 工具链缓存（配置见 worker-read-roots.json）+ cwd。
 * 配置文件缺失 / 读不动时回落到内置基础集，不能因为一个坏文件把 worker 的读面变没了。
 *
 * 调优口：PI_SANDBOX_READ_EXTRA=<dir>:…  追加只读根（单条命令级）；
 *         PI_SANDBOX_READ_OPEN=1           退回全盘只读（逃生口，慎用）。
 * 漏了路径的表现是「命令读不到东西」（EACCES/ENOENT），不是命令直接挂。
 */
function workerReadRoots() {
  const home = homedir();
  const fallback = [
    "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/proc", "/sys", "/dev", "/run",
    join(home, ".cache"), join(home, ".npm"), join(home, ".nvm"),
    join(home, ".cargo"), join(home, ".rustup"), join(home, ".moon"), join(home, "go"),
    join(home, ".local", "share"), join(home, ".local", "bin"),
    join(home, ".gitconfig"), join(home, ".config", "git"),
  ];
  const configured = readWorkerReadRoots();
  const roots = configured.length > 0 ? configured : fallback;
  const extra = process.env.PI_SANDBOX_READ_EXTRA
    ? process.env.PI_SANDBOX_READ_EXTRA.split(":").filter(Boolean)
    : [];
  return [...roots, ...extra];
}

/** worker 读面是否走白名单（主 agent 始终全盘只读；PI_SANDBOX_READ_OPEN=1 退回全盘） */
function workerReadScoped() {
  return process.env.PI_SUBAGENT === "1" && process.env.PI_SANDBOX_READ_OPEN !== "1";
}

/** 直接执行 bash（豁免命令 / 非沙箱平台 / 完全开放：文件系统不沙箱，但内存墙照常） */
function execBash(command) {
  return runCommand("bash", ["-c", command], process.cwd());
}

/**
 * 过滤掉不存在的授权路径。
 *
 * landlock-run 是 fail-closed：任何一条授权路径打不开就直接 exit 125，命令根本不执行。
 * 于是「白名单里有个陈旧目录」或者「会话里授权过的目录已被删/改名」会让**所有**命令全挂，
 * 而报错只说 cannot open rule path，指不到真凶（常驻项目根被 mv 走一次就能复现）。
 *
 * 丢弃一条写权限是收窄不是放宽，仍然 fail-closed：把「全盘瘫痪」降级成
 * 「那条路径变回只读」，并打一行警告说明丢的是哪条、从哪来。
 *
 * opts.quiet：worker 读白名单是「尽力允许」的能力缓存集合（~/.nvm、~/.config/git
 * 这类本机可能压根没装），每条命令都刷一遍警告只是噪音；可写根那种显式授权缺了才值得出声。
 */
function filterExisting(paths, source, opts = {}) {
  const kept = [];
  for (const p of paths) {
    if (!p) continue;
    if (existsSync(p)) {
      if (!kept.includes(p)) kept.push(p);
      continue;
    }
    if (!opts.quiet) {
      console.error(`sandbox-shell: 忽略不存在的授权路径（来源：${source}）：${p}`);
    }
  }
  return kept;
}

/**
 * 细粒度 grants 构造：
 *   默认：--ro / + --rw /tmp /dev/null <cwd>（写工作区）
 *   worker（PI_SUBAGENT=1，非 READ_OPEN）：--ro 换成读白名单（见 workerReadRoots）
 *   PI_SANDBOX_RW=<dir>[:…]：可写根替换 cwd（subagent 只写指定目录，工程其余只读）
 *   PI_SANDBOX_READONLY=1：只读模式，不写 workspace（/tmp /dev/null 保留作临时文件）
 *
 * 所有路径都过 filterExisting：缺一条不该让整条命令跑不起来。
 */
function buildGrants() {
  const builtin = filterExisting(["/tmp", "/dev/null"], "内置");
  const rw = [...builtin];
  if (process.env.PI_SANDBOX_READONLY !== "1") {
    if (process.env.PI_SANDBOX_RW) {
      // subagent：只能写指定的 sandboxDir，工程其余只读——保持隔离，不叠加白名单
      for (const dir of filterExisting(process.env.PI_SANDBOX_RW.split(":"), "PI_SANDBOX_RW")) {
        if (!rw.includes(dir)) rw.push(dir);
      }
    } else if (process.env.PI_SUBAGENT !== "1") {
      // 主 agent 默认：白名单目录（sandbox-paths.json 的 allowDirs）作为常驻可写根，
      // bash 可直接写这些目录，免走 sandbox-allow 一次授权。
      // worker 不走这条：allowDirs 是提督给自己开的白名单，worker 的写面只有
      // /tmp 与派工指定的可写根；worker 既没 READONLY 又没 RW 时按「只写 /tmp」收敛。
      for (const dir of filterExisting([process.cwd(), ...readAllowDirs()], "cwd / allowDirs")) {
        if (!rw.includes(dir)) rw.push(dir);
      }
    }
  }
  // 一次性升权：额外可写根，叠加在默认 cwd 之上（sandbox-allow 注入 PI_SANDBOX_RW_EXTRA）
  if (process.env.PI_SANDBOX_RW_EXTRA) {
    for (const dir of filterExisting(process.env.PI_SANDBOX_RW_EXTRA.split(":"), "PI_SANDBOX_RW_EXTRA")) {
      if (!rw.includes(dir)) rw.push(dir);
    }
  }
  const grants = [];
  if (workerReadScoped()) {
    // worker：读面收成白名单（cwd 与可写根另行授予，这里保证它们可读）
    for (const dir of filterExisting([process.cwd(), ...workerReadRoots()], "worker 读白名单", { quiet: true })) {
      grants.push("--ro", dir);
    }
  } else {
    grants.push("--ro", "/");
  }
  for (const dir of rw) grants.push("--rw", dir);
  return grants;
}

/**
 * 本条命令要不要挂 seccomp 网络墙。
 *   PI_SANDBOX_NET=allow → 不挂（capability 已批本条命令出网）
 *   PI_SANDBOX_NET=block → 挂
 *   未设 → worker 挂（默认不带网），主 agent 不挂
 */
function networkWallWanted() {
  const explicit = process.env.PI_SANDBOX_NET;
  if (explicit === "allow") return false;
  if (explicit === "block") return true;
  return process.env.PI_SUBAGENT === "1";
}

/**
 * 经 landlock-run（文件系统）+ 可选 seccomp 网络墙执行。
 *
 * 两个 launcher 前后串联：landlock 先给自身落规则、exec 网络 runner，runner 再落 seccomp、
 * exec 真正的命令——两条限制都跨 execve 继承。
 * 网络 runner 缺失时降级为「不断网」并出声：审核链仍然在，只是少一层内核兜底，
 * 不该让 worker 的所有命令全挂（那是把加固变成故障）。
 */
function execSandboxed(command, launcher) {
  const argv = [];
  if (networkWallWanted()) {
    const netRun = process.env.NETWORK_BLOCK_RUN || VENDORED_NETWORK_BLOCK;
    if (existsSync(netRun)) {
      // 网络墙在前、landlock 在后：runner 自身住在 agent 目录里，
      // 先落 landlock 的话它连 exec 自己都拿不到读权限（worker 读面是白名单）。
      // seccomp 是 no_new_privs + 过滤网，不影响後面 landlock 再落一层。
      argv.push(netRun);
      netBlockedThisRun = true;
    } else {
      console.error(
        `sandbox-shell: 找不到网络墙 runner（${netRun}），本条命令不做内核级断网（capability 审批链仍然生效）。` +
        "编译：cc -O2 -Wall -Wextra -o scripts/vendor/network-block-run scripts/network-block-run.c -lseccomp",
      );
    }
  }
  const grants = buildGrants();
  argv.push(launcher, ...grants, "--", "bash", "-c", command);
  return runCommand(argv[0], argv.slice(1), process.cwd(), { watchPaths: writableRootsOf(grants) });
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

// 2. 主 agent 可配置 sandboxExempt，但 worker 子进程永远不继承这条逃生口：
//    worker 的额外能力必须走 capability request → 主对话审批，不能靠全局前缀绕过。
const exempt = process.env.PI_SUBAGENT === "1" ? [] : readSettings().sandboxExempt;
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
