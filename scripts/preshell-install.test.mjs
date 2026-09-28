#!/usr/bin/env node
// scripts/preshell-install.test.mjs — preshell-install.mjs 的自测（测试桩 + 临时 runtime 目录）
//
// 跑法：
//   node scripts/preshell-install.test.mjs
//   PRESHELL_INSTALL_TEST_SHADOW=1 node scripts/preshell-install.test.mjs   # 额外跑一例真影子对比（约 15s）
//
// 全部动作落在 os.tmpdir() 的临时目录里，不碰 ~/.pi/runtime、不碰真实 sessions。
// 覆盖：无 SHA256SUMS / 有 SHA256SUMS 不符 → 拒绝 · 门禁缺项 → 拒绝 · --force 越过 ·
//       重复安装幂等 · use 切换与回滚 · status 列出与标记当前 · 切链后软链可解析

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(HERE, "preshell-install.mjs");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function run(args) {
  const proc = spawnSync(process.execPath, [INSTALL, ...args], { encoding: "utf8", timeout: 60000 });
  return { code: proc.status, out: `${proc.stdout ?? ""}${proc.stderr ?? ""}` };
}

function baseSpec(version) {
  return {
    tool: "preshell",
    version,
    one_line: "test stub",
    modes: [
      { name: "single", stdin: "one command", stdout: "one report" },
      { name: "stream", flag: "--stream", stdin: "one request per line", stdout: "one answer per line" },
    ],
    exit_codes: { 0: "answers produced", 2: "usage error", other: "tool failed" },
    refusal: { shape: '{"error":"...","line":N}', means: "not a request", note: "not a report" },
    client_obligations: ["serialize writes", "buffer reads by newline", "unguessable ids", "no fd inheritance"],
    paths: {
      base: "b",
      vars: "v",
      required: "r",
      always_absolute: "a",
      cd_scope: "c",
      no_base: "n",
      origin: "o",
      payload: "p",
      candidates: "cd",
    },
  };
}

/** 测试桩：认识 --version / --spec，其余读掉 stdin 给个空报告 */
function makeStub(dir, version, spec) {
  const specFile = join(dir, `spec-${version}.json`);
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const file = join(dir, `preshell-${version}-x86_64-linux`);
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      'case "$1" in',
      `  --version) printf '%s\\n' '{"tool":"preshell","version":"${version}"}' ;;`,
      `  --spec) cat ${specFile} ;;`,
      "  *) cat >/dev/null; printf '%s\\n' '" +
        JSON.stringify({ tool: "preshell", version, status: "Complete", impact: { effects: [], write_roots: [], uncertain: false } }) +
        "' ;;",
      "esac",
      "",
    ].join("\n"),
  );
  fs.chmodSync(file, 0o755);
  return file;
}

const tmpRoot = fs.mkdtempSync(join(tmpdir(), "preshell-install-test-"));
const stubDir = join(tmpRoot, "stubs");
const stubDir8 = join(tmpRoot, "stubs8");
const tamperedDir = join(tmpRoot, "tampered");
const badDir = join(tmpRoot, "badsums");
const runtime = join(tmpRoot, "runtime");
for (const d of [stubDir, stubDir8, tamperedDir, badDir, runtime]) fs.mkdirSync(d, { recursive: true });

const binA = makeStub(stubDir, "9.9.9", baseSpec("9.9.9"));
makeStub(stubDir8, "9.9.8", baseSpec("9.9.8"));
const tamperedSpec = baseSpec("9.9.7");
delete tamperedSpec.paths.candidates;
delete tamperedSpec.exit_codes["2"];
const binTampered = makeStub(tamperedDir, "9.9.7", tamperedSpec);

const link = join(runtime, "preshell");
const readLink = () => {
  try {
    const st = fs.lstatSync(link);
    return st.isSymbolicLink() ? fs.readlinkSync(link) : null;
  } catch {
    return undefined;
  }
};
const strays = () => fs.readdirSync(runtime).filter((n) => n.startsWith(".preshell"));

try {
  console.log("\n[1] install --from（无 SHA256SUMS：自己算并记账）");
  let r = run(["install", "--from", stubDir, "--runtime-dir", runtime, "--skip-shadow"]);
  check("退出码 0", r.code === 0, `code=${r.code}\n${r.out}`);
  check("软链指向 preshell-9.9.9", readLink() === "preshell-9.9.9", String(readLink()));
  check("二进制在位且可执行", fs.existsSync(join(runtime, "preshell-9.9.9")) && (fs.statSync(join(runtime, "preshell-9.9.9")).mode & 0o111) !== 0);
  const recorded = fs.readFileSync(join(runtime, "preshell-9.9.9.sha256"), "utf8").trim();
  check("sha256 记账是 sha256sum -c 格式", /^[0-9a-f]{64} {2}preshell-9\.9\.9$/.test(recorded), recorded);
  check("没有残留临时文件", strays().length === 0, strays().join(" "));

  console.log("\n[2] 同一版本再装一次（幂等、不堆垃圾）");
  const before = fs.readdirSync(runtime).sort();
  r = run(["install", "--from", stubDir, "--runtime-dir", runtime, "--skip-shadow"]);
  check("退出码 0", r.code === 0, `code=${r.code}`);
  check("打印了「复用」", /已存在且 sha 一致，复用/.test(r.out));
  check("目录内容没变", JSON.stringify(fs.readdirSync(runtime).sort()) === JSON.stringify(before), fs.readdirSync(runtime).join(" "));

  console.log("\n[3] 门禁：篡改的 --spec（缺 paths.candidates / exit_codes[\"2\"]）默认拒绝");
  r = run(["install", "--file", binTampered, "--runtime-dir", runtime, "--skip-shadow"]);
  check("退出码 1", r.code === 1, `code=${r.code}`);
  check("点名缺项", /paths\.candidates/.test(r.out) && /exit_codes\.2/.test(r.out), r.out.slice(-400));
  check("没落盘", !fs.existsSync(join(runtime, "preshell-9.9.7")));
  check("软链没动", readLink() === "preshell-9.9.9");

  console.log("\n[4] 同一份加 --force：装成，且把越过的项打出来");
  r = run(["install", "--file", binTampered, "--runtime-dir", runtime, "--skip-shadow", "--force"]);
  check("退出码 0", r.code === 0, `code=${r.code}\n${r.out}`);
  check("打印了越过的项", /本次被 --force 越过的项/.test(r.out));
  check("切到 preshell-9.9.7", readLink() === "preshell-9.9.7");

  console.log("\n[4b] install 9.9.8（第二版：后面 use 切换与回滚要用）");
  r = run(["install", "--from", stubDir8, "--runtime-dir", runtime, "--skip-shadow"]);
  check("退出码 0", r.code === 0, `code=${r.code}\n${r.out.slice(-300)}`);
  check("切到 preshell-9.9.8", readLink() === "preshell-9.9.8");

  console.log("\n[5] use：切回 9.9.9（回滚演练）");
  r = run(["use", "9.9.9", "--runtime-dir", runtime]);
  check("退出码 0", r.code === 0, `code=${r.code}\n${r.out}`);
  check("软链指向 9.9.9", readLink() === "preshell-9.9.9");
  const viaLink = spawnSync(link, ["--version"], { encoding: "utf8" });
  check("经软链 --version 仍然是 9.9.9", viaLink.status === 0 && /9\.9\.9/.test(viaLink.stdout), viaLink.stdout);
  r = run(["use", "9.9.7", "--runtime-dir", runtime]);
  check("缺项版本 use 被拒（不给 --force）", r.code === 1 && /契约门禁没过/.test(r.out), `code=${r.code}`);
  r = run(["use", "0.5", "--runtime-dir", runtime]);
  check("主次版号简写找不到时给出说法", r.code === 1 && /没有装过/.test(r.out), r.out.trim());

  console.log("\n[6] status：列出已装版本 + 标记当前");
  r = run(["status", "--runtime-dir", runtime]);
  check("退出码 0", r.code === 0, `code=${r.code}`);
  check("列出 9.9.9 / 9.9.8 / 9.9.7", ["9.9.9", "9.9.8", "9.9.7"].every((v) => r.out.includes(v)));
  check("标了当前指向", /← 当前/.test(r.out) && /preshell-9\.9\.9/.test(r.out));
  check("带 spec 要点", /modes=single,stream/.test(r.out) && /paths\(9\)/.test(r.out));
  check("标出缺项版本", /门禁：\d+\/17 通过 · 缺/.test(r.out));

  console.log("\n[7] sha256 与 SHA256SUMS 不符：拒绝");
  fs.copyFileSync(binA, join(badDir, "preshell-9.9.9-x86_64-linux"));
  fs.writeFileSync(join(badDir, "SHA256SUMS"), `${"1".repeat(64)}  preshell-9.9.9-x86_64-linux\n`);
  r = run(["install", "--from", badDir, "--runtime-dir", runtime, "--skip-shadow"]);
  check("退出码 1", r.code === 1, `code=${r.code}`);
  check("说了不符", /sha256 与 SHA256SUMS 不符/.test(r.out), r.out.slice(-300));

  console.log("\n[8] 切链是原子替换：连切多次后软链始终可解析");
  let atomicOk = true;
  for (let i = 0; i < 6; i++) {
    const v = i % 2 === 0 ? "9.9.8" : "9.9.9";
    run(["use", v, "--runtime-dir", runtime]);
    const t = readLink();
    if (t !== `preshell-${v}` || !fs.existsSync(link)) atomicOk = false;
  }
  check("切换后指向正确且链接存在", atomicOk);
  check("切换没留下残留", strays().length === 0, strays().join(" "));

  if (process.env.PRESHELL_INSTALL_TEST_SHADOW === "1") {
    console.log("\n[9] 真影子对比（PRESHELL_INSTALL_TEST_SHADOW=1）");
    r = run(["install", "--from", stubDir8, "--runtime-dir", runtime, "--shadow-n", "5"]);
    check("9.9.8 装完并切链", r.code === 0 && readLink() === "preshell-9.9.8", `code=${r.code}\n${r.out.slice(-300)}`);
    // 桩二进制不是真 preshell：影子脚本会照跑（它只喂命令），可能报错或正常返回；这里只断言脚本没崩
    check("install 走完了影子那一步（不因影子自身崩掉）", r.code === 0 || /影子对比没跑成/.test(r.out), r.out.slice(-300));
    check("影子输出落在 /tmp/preshell-shadow-9.9.8.txt", fs.existsSync(join(tmpdir(), "preshell-shadow-9.9.8.txt")));
  } else {
    console.log("\n[9] 跳过真影子对比（要跑设 PRESHELL_INSTALL_TEST_SHADOW=1）");
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n通过 ${passed} · 失败 ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
