#!/usr/bin/env -S node --experimental-strip-types
// pre-commit-check.ts —— Git 提交前检查
// 由 git-commit skill 调用，返回非零退出码表示有需要人工确认的问题

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

type Level = "WARN" | "ERROR";

interface Finding { level: Level; title: string; items?: string[] }

const findings: Finding[] = [];

function issue(level: Level, title: string, items?: string[]) {
  findings.push({ level, title, items });
}

// ---------------------------------------------------------------------------
// 1. 确定待检查的文件列表
// ---------------------------------------------------------------------------

let files = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);

if (files.length === 0) {
  issue("WARN", "暂存区为空，将检查工作区变更");
  files = git(["diff", "--name-only"]).split("\n").filter(Boolean);
}

if (files.length === 0) {
  files = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
}

if (files.length === 0) {
  console.log("没有待提交的文件。");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. 未跟踪的新文件
// ---------------------------------------------------------------------------

const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
if (untracked.length > 0) {
  issue("WARN", "发现未跟踪文件", untracked);
}

// ---------------------------------------------------------------------------
// 3. 调试残留
// ---------------------------------------------------------------------------

const SELF = new URL(import.meta.url).pathname;
const PI_AGENT_DIR = resolve(process.env.HOME ?? "/root", ".pi/agent");

// 调试残留只检查代码文件
const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".c", ".cpp", ".h",
  ".java", ".kt", ".swift", ".sh", ".bash", ".zsh",
]);

/** 测试文件中的 console 是合理行为，跳过检查 */
function isTestFile(f: string): boolean {
  return f.endsWith(".test.ts") || f.endsWith(".test.tsx") || f.endsWith(".test.js");
}

// console.* 只在 pi 配置目录下视为调试残留，其他项目当作正常代码
const consolePatterns: { label: string; pattern: RegExp }[] = [
  { label: "console.log",   pattern: /console\.log\s*\(/ },
  { label: "console.warn",  pattern: /console\.warn\s*\(/ },
  { label: "console.error", pattern: /console\.error\s*\(/ },
];

const debugPatterns: { label: string; pattern: RegExp }[] = [
  { label: "debugger",       pattern: /debugger/ },
  { label: "print()",        pattern: /print\s*\(\s*$/m },
  { label: "<!-- DEBUG -->", pattern: /<!-- DEBUG -->/ },
  { label: ".only()",        pattern: /\.only\s*\(/ },
  { label: "fdescribe",      pattern: /fdescribe\s*\(/ },
  { label: "fit",            pattern: /fit\s*\(/ },
];

// console.* — 仅当文件在 ~/.pi/agent 下才报告
for (const { label, pattern } of consolePatterns) {
  const hits: string[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    if (resolve(f) === SELF) continue;
    if (isTestFile(f)) continue;
    if (!resolve(f).startsWith(PI_AGENT_DIR)) continue;
    if (!CODE_EXTS.has(f.slice(f.lastIndexOf(".")))) continue;
    const content = readFileSync(f, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        hits.push(`\`${f}:${i + 1}\` ${lines[i].trim().slice(0, 80)}`);
      }
    }
  }
  if (hits.length > 0) {
    issue("ERROR", `疑似调试代码 — ${label}`, hits);
  }
}

// 其他调试残留 — 所有代码文件通用
for (const { label, pattern } of debugPatterns) {
  const hits: string[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    if (resolve(f) === SELF) continue;
    if (isTestFile(f)) continue;
    if (!CODE_EXTS.has(f.slice(f.lastIndexOf(".")))) continue;
    const content = readFileSync(f, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        hits.push(`\`${f}:${i + 1}\` ${lines[i].trim().slice(0, 80)}`);
      }
    }
  }
  if (hits.length > 0) {
    issue("ERROR", `疑似调试代码 — ${label}`, hits);
  }
}

// ---------------------------------------------------------------------------
// 4. 合并冲突标记
// ---------------------------------------------------------------------------

const conflictPattern = /^(<<<<<<<|=======|>>>>>>>)/;
const conflictHits: string[] = [];
for (const f of files) {
  if (!existsSync(f)) continue;
  if (resolve(f) === SELF) continue;
  if (isTestFile(f)) continue;
  if (!CODE_EXTS.has(f.slice(f.lastIndexOf(".")))) continue;
  const content = readFileSync(f, "utf-8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (conflictPattern.test(lines[i])) {
      conflictHits.push(`\`${f}:${i + 1}\` ${lines[i].trim()}`);
    }
  }
}
if (conflictHits.length > 0) {
  issue("ERROR", "合并冲突未解决", conflictHits);
}

// ---------------------------------------------------------------------------
// 5. 疑似敏感文件
// ---------------------------------------------------------------------------

const sensitivePatterns = [
  /\.env$/,
  /\.env\./,
  /credentials/i,
  /secret/i,
  /private[_-]?key/i,
  /\.pem$/,
  /id_rsa/,
  /\.token$/,
];

const sensitiveFiles = files.filter((f) => sensitivePatterns.some((p) => p.test(f)));
if (sensitiveFiles.length > 0) {
  issue("ERROR", "疑似敏感文件", sensitiveFiles.map((f) => `\`${f}\``));
}

// ---------------------------------------------------------------------------
// 6. 超大文件（>1MB）
// ---------------------------------------------------------------------------

const ONE_MB = 1048576;
const bigFiles: string[] = [];
for (const f of files) {
  if (!existsSync(f)) continue;
  const size = statSync(f).size;
  if (size > ONE_MB) {
    const mb = (size / ONE_MB).toFixed(1);
    bigFiles.push(`\`${f}\` (${mb} MB)`);
  }
}
if (bigFiles.length > 0) {
  issue("WARN", "超大文件 (>1MB)", bigFiles);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const errors = findings.filter((f) => f.level === "ERROR");
const warns = findings.filter((f) => f.level === "WARN");

if (errors.length > 0) {
  console.log("## 提交前检查发现问题\n");
  for (const f of findings) {
    console.log(`- **${f.level === "ERROR" ? "✗" : "⚠"} ${f.title}**`);
    if (f.items) {
      for (const item of f.items) console.log(`  - ${item}`);
    }
  }
  console.log(`\n> ${errors.length} errors, ${warns.length} warnings`);
  process.exit(1);
}

if (warns.length > 0) {
  console.log("## 提交前检查\n");
  for (const f of findings) {
    console.log(`- **⚠ ${f.title}**`);
    if (f.items) {
      for (const item of f.items) console.log(`  - ${item}`);
    }
  }
  console.log(`\n> 检查通过，以上警告请人工确认。`);
  process.exit(0);
}

console.log("检查通过。0 errors, 0 warnings");
process.exit(0);
