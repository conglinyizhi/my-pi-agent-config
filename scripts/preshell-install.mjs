#!/usr/bin/env node
// scripts/preshell-install.mjs — preshell 的安装 / 切换 / 回滚（部署侧，A/B）
//
// 背景：preshell 是 pi 命令审核链的事实层（独立子进程，静态分析器），二进制与 pi 侧的适配代码
// 存在版本耦合：新二进制配旧代码、或新代码配旧二进制，都会让判定退回旧的子串匹配
// （误报变多，不是漏拦）。升级踩过两次，所以「装 / 切 / 回滚」要做成可重放、可回滚的流程。
//
// 目录布局（~/.pi/runtime/）：
//   preshell              → 软链，指向当前生效的那一版（切换走 rename，原子替换）
//   preshell-0.5.0        二进制本体
//   preshell-0.5.0.sha256 同行记的摘要（sha256sum -c 格式：<sha>␣␣preshell-0.5.0）
//   preshell-0.4.1        （留着的旧版，回滚用）
//
// 用法：
//   node scripts/preshell-install.mjs install (--from DIR | --release vX.Y.Z | --file PATH)
//        [--skip-shadow] [--force] [--shadow-n N] [--runtime-dir DIR]
//     拿到产物 → 验 sha256（目录里有 SHA256SUMS 就用它；没有就自己算并记下来）
//     → 读 --spec 过门禁 → 落到 preshell-<版本> → 默认先跑一轮影子对比 → 原子切软链 → 打印回滚命令
//
//   node scripts/preshell-install.mjs use <版本|0.5|v0.5.0|preshell-0.5.0> [--force]
//     只切软链。回滚走的就是它（use 0.4.1 把链路切回旧版）。
//
//   node scripts/preshell-install.mjs status
//     列出已装版本、各自 sha（与记账比对）、当前软链指向，以及二进制自报的 version / spec 要点。
//
//   --runtime-dir DIR（或环境变量 PI_RUNTIME_DIR）只给测试用，缺省 ~/.pi/runtime。
//   --force 越过门禁缺项与 sha 不符；越过的每一项都会照样打印出来。
//   退出码：0 成功；1 拒绝/失败；2 用法错误。
//
// 影子对比（切链之前跑，默认小样本）：
//   脚本自己跑 node --experimental-strip-types scripts/preshell-shadow.ts --bin ~/.pi/runtime/preshell-<版本> --n <N>
//   结果落在 /tmp/preshell-shadow-<版本>.txt（路径每次都打印）。N 默认 40（够看出方向，十几秒量级）；
//   要看全量自己手动跑：
//     node --experimental-strip-types scripts/preshell-shadow.ts --bin ~/.pi/runtime/preshell --n 0
//   样本跑不动（会话文件太大、脚本不在）时，要么修，要么显式 --skip-shadow 跳过。
//
// 门禁的限度（重要）：
//   它是「切链之前先看一眼」的形状检查，不是安全边界。只对 `--spec` 里**契约项存在性**做判断，
//   不验语义（比如 exit_codes["2"] 的文案到底写的是什么）、不验行为、也拦不住恶意二进制
//   （产物自己就能编一份漂亮的 --spec）。真正的防线是 sha256 校验 + 影子对比 + 一条命令回滚。
//   GATE 里每一项都注明它对应 pi 侧代码的哪一处依赖，缺项时照抄给提督看。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = dirname(HERE);
const SHADOW_SCRIPT = join(HERE, "preshell-shadow.ts");
const PRESHELL_LIB = join(AGENT_DIR, "lib", "preshell.ts");
const LINK_NAME = "preshell";
const UPSTREAM_REPO = "conglinyizhi/preshell";
const PROXY_DEFAULT = "http://127.0.0.1:10738";
const SHA_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

let RUNTIME = join(homedir(), ".pi", "runtime");

const linkPath = () => join(RUNTIME, LINK_NAME);
const versionPath = (version) => join(RUNTIME, `${LINK_NAME}-${version}`);
const sumsPath = (version) => join(RUNTIME, `${LINK_NAME}-${version}.sha256`);

// ── 门禁清单 ──
//
// 每一项：id（给人看的名字）、at（在 --spec 里的位置）、check（存在性判断）、why（pi 侧哪一处依赖它）。
// level：required = 缺了默认拒绝安装；advisory = 缺了只提示（对应的代码路径本来就有兜底/还没接线）。
//
// 清单来源：lib/preshell.ts 与 lib/preshell-stream.ts 里实际读写的字段，外加 lib/sandbox-check.ts
// 消费的两个效果字段（origin / candidates）。改这两份 lib 时这份清单要跟着改。
const GATE = [
  {
    id: "tool",
    at: "--spec 顶层 tool",
    level: "required",
    check: (s) => s.tool === "preshell",
    why: "装进来的必须是 preshell 本体：lib/preshell.ts:572 只认 --version 里的 version 字符串，身份靠这里对",
  },
  {
    id: "version",
    at: "--spec 顶层 version",
    level: "required",
    check: (s) => typeof s.version === "string" && VERSION_RE.test(s.version.trim()),
    why: "lib/preshell.ts 只在报告里拿 version 当「实测版本」用（已不参与兼容性判定，pi 侧改看能力探测）；但版本号读不出 = 这个产物不正常",
  },
  {
    id: "modes.stream",
    at: 'modes[] 里有 name/flag 为 stream（--stream）',
    level: "required",
    check: (s) => (Array.isArray(s.modes) ? s.modes : []).some((m) => m && (m.flag === "--stream" || m.name === "stream")),
    why: "lib/preshell-stream.ts:100 streamSupported() 拿 --help 里的 --stream 探能力、:286 spawn(bin, [\"--stream\"])；缺了批量路径直接 markDead（:281）",
  },
  {
    id: "exit_codes.0",
    at: "exit_codes 有键 0",
    level: "required",
    check: (s) => has(s.exit_codes, "0"),
    why: "lib/preshell.ts:640 把非零退出码当失败，只有 0 才读 stdout 那份报告",
  },
  {
    id: "exit_codes.2",
    at: "exit_codes 有键 2",
    level: "required",
    check: (s) => has(s.exit_codes, "2"),
    why: "lib/preshell.ts:22 与 :607-612：cwd 不是绝对路径时不给工具 --cwd，因为给了就是用法错误（退出码 2）；这条是那个取舍的依据",
  },
  {
    id: "refusal.error",
    at: "refusal.shape 里的 error 字段",
    level: "required",
    check: (s) => typeof s.refusal?.shape === "string" && /"error"/.test(s.refusal.shape),
    why: "lib/preshell-stream.ts:258-259 handleLine 把应答里的 error 字段翻成 bad-json 失败；形状变了会被当成坏行",
  },
  {
    id: "refusal.line",
    at: "refusal.shape 里的 line 字段",
    level: "required",
    check: (s) => typeof s.refusal?.shape === "string" && /"line"/.test(s.refusal.shape),
    why: "同上：坏行要能定位到第几行（preshell-stream.ts:258 那段的分支就是冲着这个形状写的）",
  },
  {
    id: "client_obligations",
    at: "client_obligations（非空字符串数组）",
    level: "required",
    check: (s) => Array.isArray(s.client_obligations) && s.client_obligations.length > 0 && s.client_obligations.every((x) => typeof x === "string"),
    why: "lib/preshell-stream.ts:24-28 头注逐条对应的四项义务（串行写、按 \\n 缓冲、id 不可猜、fd 不继承）；数组没了说明契约文本被改过",
  },
  {
    id: "paths.base",
    at: "paths.base",
    level: "required",
    check: (s) => has(s.paths, "base"),
    why: "lib/preshell.ts:630 传 --cwd=<绝对路径>；lib/sandbox-check.ts:292 base = facts.cwd ?? ctx.cwd 靠它解析相对路径",
  },
  {
    id: "paths.required",
    at: "paths.required",
    level: "required",
    check: (s) => has(s.paths, "required"),
    why: "lib/preshell.ts:607-612 cwdRejected：--cwd 缺失/非绝对路径时不给工具值，改由它自己推演——这条说清了不给的后果",
  },
  {
    id: "paths.vars",
    at: "paths.vars",
    level: "required",
    check: (s) => has(s.paths, "vars"),
    why: "lib/preshell.ts:363 substituteVariables / :386 resolvePath / :477 impact.vars：洞里的变量名要由我们替换（环境在我们手上）",
  },
  {
    id: "paths.always_absolute",
    at: "paths.always_absolute",
    level: "required",
    check: (s) => has(s.paths, "always_absolute"),
    why: "lib/preshell.ts:429 settlePaths 出来的路径直接拿去比黑名单（lib/sandbox-check.ts:299）；说好绝对路径才能这么用",
  },
  {
    id: "paths.cd_scope",
    at: "paths.cd_scope",
    level: "required",
    check: (s) => has(s.paths, "cd_scope"),
    why: "lib/preshell.ts:465 收尾基准优先用报告回的 impact.cwd（命令内部 cd 过就是 cd 之后那个）",
  },
  {
    id: "paths.no_base",
    at: "paths.no_base",
    level: "required",
    check: (s) => has(s.paths, "no_base"),
    why: "lib/preshell.ts:471 facts.uncertain；lib/sandbox-check.ts:336 一旦 incomplete 就不拿「没报写」当「不写」",
  },
  {
    id: "paths.origin",
    at: "paths.origin",
    level: "required",
    check: (s) => has(s.paths, "origin"),
    why: "lib/preshell.ts:103 effect.origin；lib/sandbox-check.ts:195 用 origin 把效果对回命令行、:468 那张程序名表",
  },
  {
    id: "paths.candidates",
    at: "paths.candidates",
    level: "required",
    check: (s) => has(s.paths, "candidates"),
    why: "lib/sandbox-check.ts:186 / :309 候选集逐个判（命中即拦）；没有它 v0.4 那档收紧就收不到",
  },
  {
    id: "paths.payload",
    at: "paths.payload",
    level: "advisory",
    check: (s) => has(s.paths, "payload"),
    why: "lib/preshell.ts:58 PreshellPayload / :116 effect.payload——本侧只解析、还没接线，缺了照旧能跑（v0.4.1 就没有这条）",
  },
];

function has(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

/** 跑一遍门禁；只做存在性，不做语义与行为判断（限度见文件头） */
function runGate(spec) {
  const missingRequired = [];
  const missingAdvisory = [];
  for (const item of GATE) {
    let ok = false;
    try {
      ok = item.check(spec) === true;
    } catch {
      ok = false;
    }
    if (!ok) (item.level === "required" ? missingRequired : missingAdvisory).push(item);
  }
  return { missingRequired, missingAdvisory, total: GATE.length };
}

function printGateResult(gate) {
  const bad = gate.missingRequired.length;
  log(`  契约门禁：${gate.total - bad}/${gate.total} 项通过${bad > 0 ? `（缺 ${bad} 项）` : ""}`);
  for (const item of gate.missingRequired) log(`    ✗ 缺 ${item.id}（${item.at}）\n      ↳ ${item.why}`);
  for (const item of gate.missingAdvisory) log(`    · 缺 ${item.id}（${item.at}，提示级）\n      ↳ ${item.why}`);
}

// ── 小工具 ──

function log(...args) {
  console.log(...args);
}

function fail(message) {
  console.error(`错误：${message}`);
}

function sha256File(path) {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

function readRecordedSha(version) {
  const p = sumsPath(version);
  if (!fs.existsSync(p)) return undefined;
  const m = /^([0-9a-fA-F]{64})/.exec(fs.readFileSync(p, "utf8").trim());
  return m ? m[1].toLowerCase() : undefined;
}

function writeRecordedSha(version, sha) {
  // 临时名跟目标同目录：跨文件系统 rename 会 EXDEV
  const tmp = join(RUNTIME, `.${basename(sumsPath(version))}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${sha}  ${LINK_NAME}-${version}\n`);
  fs.renameSync(tmp, sumsPath(version));
}

function probeVersion(bin, timeoutMs = 5000) {
  const proc = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: timeoutMs });
  if (proc.error) return { ok: false, detail: proc.error.message };
  if (proc.status !== 0) return { ok: false, detail: `--version 退出码 ${proc.status}：${(proc.stderr || "").trim().slice(0, 200)}` };
  let parsed;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch {
    return { ok: false, detail: `--version 输出不是 JSON：${String(proc.stdout).trim().slice(0, 120)}` };
  }
  if (!parsed || typeof parsed.version !== "string" || !VERSION_RE.test(parsed.version.trim())) {
    return { ok: false, detail: `--version 里没有可用的 version 字符串：${String(proc.stdout).trim().slice(0, 120)}` };
  }
  return { ok: true, version: parsed.version.trim(), raw: String(proc.stdout).trim() };
}

function probeSpec(bin, timeoutMs = 10000) {
  const proc = spawnSync(bin, ["--spec"], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  if (proc.error) return { ok: false, detail: proc.error.message };
  if (proc.status !== 0) return { ok: false, detail: `--spec 退出码 ${proc.status}：${(proc.stderr || "").trim().slice(0, 200)}` };
  try {
    return { ok: true, spec: JSON.parse(proc.stdout) };
  } catch {
    return { ok: false, detail: `--spec 输出不是 JSON：${String(proc.stdout).trim().slice(0, 120)}` };
  }
}

/** pi 侧当前适配的契约版本：直接从 lib/preshell.ts 读，别把 0.5 硬编码进来 */
function readExpectedVersion() {
  try {
    const text = fs.readFileSync(PRESHELL_LIB, "utf8");
    const m = /export const RECOMMENDED_VERSION = "([^"]+)"/.exec(text);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

function compatOf(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version).trim());
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/** 版本不符只是提示：退回旧匹配 = 误报变多，不是崩，也不是漏拦 */
function printVersionCompat(version) {
  const expected = readExpectedVersion();
  if (!expected) {
    log(`  · 版本对照：读不到 lib/preshell.ts 的 RECOMMENDED_VERSION，跳过（自报 version=${version}）`);
    return;
  }
  const tool = compatOf(version);
  const want = compatOf(expected);
  if (tool && want && tool === want) {
    log(`  · 版本对照：实测 ${version}，lib/preshell.ts 记的推荐版本是 ${expected}（只作提示）`);
  } else {
    log(
      `  · 版本对照：实测 ${version}，推荐版本 ${expected} —— 不同不重要：pi 侧改看能力探测，` +
        `上面那份门禁清单通过就能用（版本号只影响提示与报告）`,
    );
  }
}

/** 软链指向：undefined = 不存在；null = 普通文件（旧布局，还没迁移） */
function readLinkState() {
  try {
    const st = fs.lstatSync(linkPath());
    return st.isSymbolicLink() ? fs.readlinkSync(linkPath()) : null;
  } catch {
    return undefined;
  }
}

function cleanStaleLinks() {
  let names = [];
  try {
    names = fs.readdirSync(RUNTIME);
  } catch {
    return [];
  }
  const stale = names.filter((n) => n.startsWith(`.${LINK_NAME}.link-`));
  for (const n of stale) {
    try {
      fs.unlinkSync(join(RUNTIME, n));
    } catch {
      // 清不掉就算了，不影响切换
    }
  }
  return stale;
}

/**
 * 原子切链：同目录临时名 + rename。
 * 不用 ln -sfn（先删后建，中间有个瞬间链接不存在，这个窗口里 pi 起 preshell 会 ENOENT）。
 */
function atomicLink(targetName) {
  const tmp = join(RUNTIME, `.${LINK_NAME}.link-${process.pid}-${Date.now()}`);
  try {
    fs.unlinkSync(tmp);
  } catch {
    // 没残留更好
  }
  fs.symlinkSync(targetName, tmp);
  try {
    fs.renameSync(tmp, linkPath());
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 同上
    }
    throw err;
  }
}

/** 落文件也走「临时名 + rename」：读到的 preshell-<版本> 要么没有、要么完整 */
function stageBinary(sourceFile, version) {
  const dest = versionPath(version);
  const tmp = join(RUNTIME, `.${LINK_NAME}-${version}.tmp-${process.pid}`);
  fs.copyFileSync(sourceFile, tmp);
  fs.chmodSync(tmp, 0o755);
  try {
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 同上
    }
    throw err;
  }
}

function listInstalled() {
  let names = [];
  try {
    names = fs.readdirSync(RUNTIME);
  } catch {
    return [];
  }
  const prefix = `${LINK_NAME}-`;
  return names
    .filter((n) => n.startsWith(prefix) && !n.endsWith(".sha256") && VERSION_RE.test(n.slice(prefix.length)) && !n.includes(".tmp-"))
    .map((n) => n.slice(prefix.length))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// ── 产物来源 ──

function readSums(dir) {
  const p = join(dir, "SHA256SUMS");
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) out.push({ sha: m[1].toLowerCase(), name: m[2] });
  }
  return out;
}

const artifactScore = (name) =>
  (/x86_64|amd64/i.test(name) ? 2 : 0) + (/linux/i.test(name) ? 2 : 0) + (/^preshell/i.test(name) ? 1 : 0);

const looksLikeArtifact = (name) => /preshell/i.test(name) && !/\.sha256$/i.test(name) && !/^SHA256SUMS$/i.test(name);

/** 从目录里挑产物：优先按 SHA256SUMS 的清单名找，没有清单就按名字打分挑（同分时把别的候选报出来） */
function pickArtifact(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
  const sums = readSums(dir);
  const usable = sums
    .filter((s) => looksLikeArtifact(basename(s.name)) && fs.existsSync(join(dir, s.name)))
    .sort((a, b) => artifactScore(b.name) - artifactScore(a.name));
  if (usable.length > 0) {
    return {
      file: join(dir, usable[0].name),
      expectedSha: usable[0].sha,
      fromSums: true, // 摘要来自目录里的 SHA256SUMS（验真伪）；没有清单时是自己算的记账
      alternatives: usable.slice(1).map((s) => s.name),
    };
  }
  const files = entries.filter(looksLikeArtifact).sort((a, b) => artifactScore(b) - artifactScore(a));
  if (files.length === 0) {
    throw new Error(`目录里找不到 preshell 产物：${dir}（目录里有：${entries.join(" ") || "空"}）`);
  }
  return { file: join(dir, files[0]), expectedSha: undefined, alternatives: files.slice(1) };
}

function ghEnv() {
  const env = { ...process.env };
  if (!env.HTTPS_PROXY) env.HTTPS_PROXY = PROXY_DEFAULT;
  if (!env.HTTP_PROXY) env.HTTP_PROXY = PROXY_DEFAULT;
  return env;
}

function runGh(args, timeoutMs = 120000) {
  const proc = spawnSync("gh", args, { encoding: "utf8", timeout: timeoutMs, env: ghEnv(), maxBuffer: 8 * 1024 * 1024 });
  if (proc.error) return { ok: false, detail: proc.error.message };
  if (proc.status !== 0) {
    return { ok: false, detail: `gh ${args.slice(0, 3).join(" ")} 退出码 ${proc.status}：${(proc.stderr || "").trim().slice(0, 300)}` };
  }
  return { ok: true, stdout: proc.stdout ?? "" };
}

/** 从 GitHub release 取产物：先列资产挑名字，再按 --pattern 只拉要的那两个 */
function fetchRelease(tag, dir) {
  log(`  从 GitHub 取 ${tag}（repo ${UPSTREAM_REPO}，代理 ${ghEnv().HTTPS_PROXY}）…`);
  const view = runGh(["release", "view", tag, "-R", UPSTREAM_REPO, "--json", "assets", "--jq", ".assets[].name"], 90000);
  if (!view.ok) {
    log(`    · 列资产失败（${view.detail}），退回整包下载`);
    const dl = runGh(["release", "download", tag, "-R", UPSTREAM_REPO, "-D", dir, "--clobber"], 180000);
    if (!dl.ok) throw new Error(`gh release download 失败：${dl.detail}`);
    return;
  }
  const names = view.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const artifacts = names.filter(looksLikeArtifact).sort((a, b) => artifactScore(b) - artifactScore(a));
  if (artifacts.length === 0) throw new Error(`${tag} 里没有 preshell 产物（资产：${names.join(" ") || "空"}）`);
  const patterns = [artifacts[0]];
  if (names.includes("SHA256SUMS")) patterns.push("SHA256SUMS");
  const args = ["release", "download", tag, "-R", UPSTREAM_REPO, "-D", dir, "--clobber"];
  for (const p of patterns) args.push("--pattern", p);
  const dl = runGh(args, 180000);
  if (!dl.ok) throw new Error(`gh release download 失败：${dl.detail}`);
  log(`    拉到：${patterns.join(" ")}`);
}

// ── 影子对比 ──

function runShadow(bin, version, n, timeoutMs) {
  const outPath = join(tmpdir(), `preshell-shadow-${version}.txt`);
  if (!fs.existsSync(SHADOW_SCRIPT)) {
    return { ok: false, outPath, detail: `影子脚本不在：${SHADOW_SCRIPT}` };
  }
  const fd = fs.openSync(outPath, "w");
  try {
    const proc = spawnSync(process.execPath, ["--experimental-strip-types", SHADOW_SCRIPT, "--bin", bin, "--n", String(n)], {
      stdio: ["ignore", fd, fd],
      timeout: timeoutMs,
    });
    if (proc.error) return { ok: false, outPath, detail: proc.error.message };
    if (proc.status !== 0) return { ok: false, outPath, detail: `影子脚本退出码 ${proc.status}（输出见 ${outPath}）` };
    return { ok: true, outPath };
  } finally {
    fs.closeSync(fd);
  }
}

// ── install ──

function cmdInstall(args) {
  const from = args.opts.from;
  const release = args.opts.release;
  const file = args.opts.file;
  const sources = [from, release, file].filter(Boolean);
  if (sources.length !== 1) {
    fail("install 需要且只需要一个来源：--from DIR / --release vX.Y.Z / --file PATH");
    return 2;
  }
  const skipShadow = args.flags.has("skip-shadow");
  const force = args.flags.has("force");
  const shadowN = Number(args.opts["shadow-n"] ?? "40");
  const shadowTimeout = Number(args.opts["shadow-timeout"] ?? "180000");

  const staging = fs.mkdtempSync(join(tmpdir(), "preshell-install-"));
  const warnings = [];
  let resolved;
  try {
    // 1) 拿到产物：一律先复制进临时目录，后面所有探测都对着这份副本做
    if (release) {
      fetchRelease(release, staging);
      resolved = pickArtifact(staging);
      // gh 下来的产物不带可执行位（gh 不保 mode），必须自己补
      fs.chmodSync(resolved.file, 0o755);
      resolved = { ...resolved, sourceLabel: `${UPSTREAM_REPO} ${release} → ${basename(resolved.file)}` };
    } else if (from) {
      const dir = from;
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        fail(`--from 不是目录：${dir}`);
        return 1;
      }
      const picked = pickArtifact(dir);
      const copy = join(staging, basename(picked.file));
      fs.copyFileSync(picked.file, copy);
      fs.chmodSync(copy, 0o755);
      resolved = { ...picked, file: copy, sourceLabel: picked.file };
    } else {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        fail(`--file 不是文件：${file}`);
        return 1;
      }
      const copy = join(staging, basename(file));
      fs.copyFileSync(file, copy);
      fs.chmodSync(copy, 0o755);
      resolved = { file: copy, expectedSha: undefined, sourceLabel: file };
    }

    const bin = resolved.file;
    log(`产物：${resolved.sourceLabel ?? bin}`);
    if (resolved.alternatives?.length > 0) {
      log(`  · 目录里有多个候选：${[basename(bin), ...resolved.alternatives.map(basename)].join(" ")}；按名字挑了这个（x86_64 / linux 优先），要指定就 --file`);
    }

    // 2) 自报版本
    const probed = probeVersion(bin);
    if (!probed.ok) {
      fail(`这个产物跑不出 --version：${probed.detail}`);
      return 1;
    }
    const version = probed.version;
    log(`  自报版本：${version}`);
    printVersionCompat(version);

    // 3) sha256：有 SHA256SUMS 就用它验，没有就自己算并记下来
    const sha = sha256File(bin);
    if (resolved.expectedSha) {
      if (resolved.expectedSha === sha) {
        log(`  sha256：${sha}（与 SHA256SUMS 一致）`);
      } else {
        const message = `sha256 与 SHA256SUMS 不符：清单 ${resolved.expectedSha}，实际 ${sha}`;
        if (!force) {
          fail(`${message}；要强装加 --force`);
          return 1;
        }
        warnings.push(`${message}（--force 越过）`);
        log(`  sha256：${message} → --force 越过`);
      }
    } else {
      log(`  sha256：${sha}（来源没有 SHA256SUMS，自己算并记账；这份摘要只能用来查「后来有没有变」，不能验真伪）`);
    }

    // 4) 门禁：读 --spec
    const specProbe = probeSpec(bin);
    if (!specProbe.ok) {
      fail(`读 --spec 失败：${specProbe.detail}（这份产物没法过门禁，要强装加 --force）`);
      if (!force) return 1;
      warnings.push(`--spec 读不到：${specProbe.detail}（--force 越过门禁）`);
    } else {
      const gate = runGate(specProbe.spec);
      printGateResult(gate);
      if (gate.missingRequired.length > 0 && !force) {
        fail(`契约门禁没过：缺 ${gate.missingRequired.map((i) => i.id).join("、")}。要强装加 --force；装旧版做回滚时缺项照旧要自己认下`);
        return 1;
      }
      if (gate.missingRequired.length > 0) warnings.push(`门禁缺 ${gate.missingRequired.length} 项（--force 越过）`);
    }

    // 5) 落文件（先不切链）
    fs.mkdirSync(RUNTIME, { recursive: true });
    cleanStaleLinks();
    const existing = fs.existsSync(versionPath(version)) ? sha256File(versionPath(version)) : undefined;
    if (existing === sha) {
      log(`  preshell-${version} 已存在且 sha 一致，复用（不重复写盘）`);
    } else if (existing !== undefined && !force) {
      fail(`preshell-${version} 已存在但 sha 不同（现有 ${existing}，新 ${sha}）；要覆盖加 --force`);
      return 1;
    } else {
      stageBinary(bin, version);
      log(`  已落到 ${versionPath(version)}（+ ${basename(sumsPath(version))}）`);
    }
    // 记账文件单独判：sha 变了（--force 覆盖）要更新，没有要补上
    if (readRecordedSha(version) !== sha) writeRecordedSha(version, sha);

    // 6) 影子对比（切链之前，默认小样本）；跑的是已经落到 runtime 里的那份，报告里记的就是真实产物路径
    if (skipShadow) {
      log("  影子对比：--skip-shadow 跳过（全量手动跑法见脚本头）");
    } else {
      log(`  影子对比：小样本 n=${shadowN}，对 preshell-${version} 跑一轮（跑的是 ${versionPath(version)}）…`);
      const shadow = runShadow(versionPath(version), version, shadowN, shadowTimeout);
      if (shadow.ok) {
        log(`    报告：${shadow.outPath}`);
      } else {
        fail(`影子对比没跑成：${shadow.detail}`);
        fail(`修好再装，或显式加 --skip-shadow 跳过（软链还没动：~/.pi/runtime/preshell 保持原样，preshell-${version} 已落盘）`);
        return 1;
      }
    }

    // 7) 原子切链
    const before = readLinkState();
    const beforeLabel = before === undefined ? "（无）" : before === null ? "（普通文件，旧布局）" : before;
    atomicLink(`${LINK_NAME}-${version}`);
    log(`  切链：${beforeLabel} → ${LINK_NAME}-${version}`);

    const keep = listInstalled().filter((v) => v !== version);
    const rollback = before && before !== `${LINK_NAME}-${version}` ? before.replace(`${LINK_NAME}-`, "") : undefined;
    log("");
    log("装好了。回滚：");
    log(rollback ? `  node ${relScript()} use ${rollback}` : keep.length > 0 ? `  node ${relScript()} use ${keep[0]}` : "  （还没有别的版本可回滚）");
    if (warnings.length > 0) {
      log("本次被 --force 越过的项：");
      for (const w of warnings) log(`  ! ${w}`);
    }
    return 0;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function relScript() {
  return join(HERE, "preshell-install.mjs");
}

// ── use ──

function normalizeVersion(input) {
  const raw = String(input).trim().replace(/^preshell-/, "").replace(/^v/, "");
  if (VERSION_RE.test(raw)) return { version: raw };
  if (/^\d+\.\d+$/.test(raw)) {
    const hits = listInstalled().filter((v) => compatOf(v) === raw);
    if (hits.length === 1) return { version: hits[0] };
    if (hits.length === 0) return { error: `没有装过 ${raw}.x 这个主次版号` };
    return { error: `${raw}.x 有多个：${hits.join(" ")}，写全` };
  }
  return { error: `版本号写法不认：${input}（要 0.5.0 / v0.5.0 / preshell-0.5.0 / 0.5）` };
}

function cmdUse(args) {
  const wanted = args._[1];
  if (!wanted) {
    fail("use 要一个版本：use 0.4.1");
    return 2;
  }
  const norm = normalizeVersion(wanted);
  if (norm.error) {
    fail(norm.error);
    return 1;
  }
  const version = norm.version;
  const force = args.flags.has("force");
  const target = versionPath(version);
  if (!fs.existsSync(target)) {
    fail(`没有这一版：${target}（status 看已装的）`);
    return 1;
  }
  const before = readLinkState();
  if (before === `${LINK_NAME}-${version}`) {
    log(`当前已经指向 ${LINK_NAME}-${version}，不用动`);
    return 0;
  }

  // 切之前照样过一遍：sha 记账 + --version + 门禁（回滚到旧版时缺项用 --force 认下）
  const recorded = readRecordedSha(version);
  const actual = sha256File(target);
  if (recorded === undefined) {
    log(`  sha256：${actual}（这一版没有记账文件，可能是手工放进去的）`);
  } else if (recorded !== actual) {
    const message = `${LINK_NAME}-${version} 与记账 sha 不符：记账 ${recorded}，实际 ${actual}`;
    if (!force) {
      fail(`${message}；确认过再加 --force`);
      return 1;
    }
    log(`  sha256：${message} → --force 越过`);
  } else {
    log(`  sha256：${actual}（与记账一致）`);
  }

  const probed = probeVersion(target);
  if (!probed.ok) {
    if (!force) {
      fail(`这一版跑不出 --version：${probed.detail}；要强切加 --force`);
      return 1;
    }
    log(`  --version：${probed.detail} → --force 越过`);
  } else {
    log(`  --version：${probed.raw}`);
    printVersionCompat(probed.version);
  }

  const specProbe = probeSpec(target);
  if (!specProbe.ok) {
    if (!force) {
      fail(`这一版读不出 --spec：${specProbe.detail}；要强切加 --force`);
      return 1;
    }
    log(`  --spec：${specProbe.detail} → --force 越过`);
  } else {
    const gate = runGate(specProbe.spec);
    printGateResult(gate);
    if (gate.missingRequired.length > 0 && !force) {
      fail(`契约门禁没过：缺 ${gate.missingRequired.map((i) => i.id).join("、")}；要强切加 --force`);
      return 1;
    }
  }

  const beforeLabel = before === undefined ? "（无）" : before === null ? "（普通文件，旧布局）" : before;
  atomicLink(`${LINK_NAME}-${version}`);
  log(`切换：${beforeLabel} → ${LINK_NAME}-${version}`);
  log(`回滚：node ${relScript()} use ${before && before !== `${LINK_NAME}-${version}` ? before.replace(`${LINK_NAME}-`, "") : "…"}`);
  return 0;
}

// ── status ──

function cmdStatus() {
  const rawNames = (() => {
    try {
      return fs.readdirSync(RUNTIME);
    } catch {
      return [];
    }
  })();
  const link = readLinkState();
  log(`runtime：${RUNTIME}`);
  if (link === undefined) log(`软链：${linkPath()} 不存在`);
  else if (link === null) log(`软链：${linkPath()} 是**普通文件**（旧布局，跑 install --file 迁移）`);
  else log(`软链：${linkPath()} → ${link}`);

  const installed = listInstalled();
  if (installed.length === 0) {
    log("已装版本：无");
    return 0;
  }
  const expected = readExpectedVersion();
  log(`已装版本（RECOMMENDED_VERSION=${expected ?? "读不到"}）：`);
  for (const version of installed) {
    const target = versionPath(version);
    let line = `  ${version}`;
    const current = link === `${LINK_NAME}-${version}`;
    line += current ? "  ← 当前" : "      ";
    const actual = sha256File(target);
    const recorded = readRecordedSha(version);
    line += `  sha256 ${actual.slice(0, 16)}…`;
    if (recorded === undefined) line += "（无记账）";
    else if (recorded !== actual) line += "  ⚠ 与记账不符";
    const st = fs.statSync(target);
    line += `  ${(st.size / 1048576).toFixed(2)}MB`;
    log(line);
    const probed = probeVersion(target);
    if (!probed.ok) {
      log(`      自报版本：读不出（${probed.detail}）`);
      continue;
    }
    const specProbe = probeSpec(target);
    if (!specProbe.ok) {
      log(`      自报 version=${probed.version} · --spec 读不出：${specProbe.detail}`);
      continue;
    }
    const spec = specProbe.spec;
    const gate = runGate(spec);
    const modes = Array.isArray(spec.modes) ? spec.modes.map((m) => m.name).filter(Boolean).join(",") : "?";
    const exitCodes = spec.exit_codes && typeof spec.exit_codes === "object" ? Object.keys(spec.exit_codes).join(",") : "?";
    const paths = spec.paths && typeof spec.paths === "object" ? Object.keys(spec.paths) : [];
    const specVersion = typeof spec.version === "string" ? spec.version : undefined;
    log(
      `      自报 version=${probed.version}` +
        (specVersion && specVersion !== probed.version ? `（--spec 里写的是 ${specVersion}）` : "") +
        ` · modes=${modes} · exit_codes=${exitCodes}`,
    );
    log(`      paths(${paths.length})：${paths.join(",")}`);
    log(
      `      门禁：${gate.total - gate.missingRequired.length}/${gate.total} 通过` +
        (gate.missingRequired.length > 0 ? ` · 缺 ${gate.missingRequired.map((i) => i.id).join("、")}` : "") +
        (gate.missingAdvisory.length > 0 ? ` · 提示级缺 ${gate.missingAdvisory.map((i) => i.id).join("、")}` : ""),
    );
  }
  const stray = rawNames.filter((n) => n.startsWith(`.${LINK_NAME}`));
  if (stray.length > 0) log(`残留临时文件：${stray.join(" ")}（install/use 下次会顺手清）`);
  return 0;
}

// ── 参数 ──

const VALUE_FLAGS = new Set(["from", "release", "file", "runtime-dir", "shadow-n", "shadow-timeout"]);
const BOOL_FLAGS = new Set(["skip-shadow", "force", "help"]);

function parseArgs(argv) {
  const out = { _: [], flags: new Set(), opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      out.flags.add("help");
      continue;
    }
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (VALUE_FLAGS.has(key)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${key} 缺值`);
      out.opts[key] = value;
      i++;
    } else if (BOOL_FLAGS.has(key)) {
      out.flags.add(key);
    } else {
      throw new Error(`不认识的选项：${a}`);
    }
  }
  return out;
}

function usage() {
  log(`用法：
  node scripts/preshell-install.mjs install --from DIR | --release vX.Y.Z | --file PATH
        [--skip-shadow] [--force] [--shadow-n N] [--shadow-timeout MS] [--runtime-dir DIR]
  node scripts/preshell-install.mjs use <版本> [--force]
  node scripts/preshell-install.mjs status [--runtime-dir DIR]

布局：${RUNTIME}/preshell → preshell-<版本>（软链），每版一份二进制 + 一份 .sha256 记账。
细节（门禁清单、影子对比跑法、原子切链）见脚本文件头。`);
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    usage();
    return 2;
  }
  if (args.flags.has("help")) {
    usage();
    return 0;
  }
  if (args.opts["runtime-dir"]) RUNTIME = args.opts["runtime-dir"];
  else if (process.env.PI_RUNTIME_DIR) RUNTIME = process.env.PI_RUNTIME_DIR;

  const cmd = args._[0];
  if (!cmd) {
    usage();
    return 2;
  }
  try {
    switch (cmd) {
      case "install":
        return cmdInstall(args);
      case "use":
        return cmdUse(args);
      case "status":
        return cmdStatus();
      default:
        fail(`不认识的子命令：${cmd}`);
        usage();
        return 2;
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
