#!/usr/bin/env -S node --experimental-strip-types
// pre-commit-check.ts —— Git 提交前检查
// 由 git-commit skill 调用，返回非零退出码表示有需要人工确认的问题

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function git(...args: string[]): string {
  try {
    return execSync(["git", ...args].join(" "), { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

let warnings = 0;
let errors = 0;

function emit(level: string, title: string, items?: string[]) {
  const lines = items?.length ? `\n     ${items.join("\n     ")}` : "";
  console.log(`[${level}] ${title}${lines}`);
}
function warn(title: string, items?: string[]) { emit("WARN", title, items); warnings++; }
function err(title: string, items?: string[])  { emit("ERROR", title, items); errors++; }
function ok(msg: string) { console.log(`[OK] ${msg}`); }

// ---------------------------------------------------------------------------
// 1. 确定待检查的文件列表
// ---------------------------------------------------------------------------

console.log("========== 提交前检查 ==========");

let files = git("diff", "--cached", "--name-only").split("\n").filter(Boolean);

if (files.length === 0) {
  console.log("[WARN] 暂存区为空，将检查工作区变更");
  files = git("diff", "--name-only").split("\n").filter(Boolean);
}

if (files.length === 0) {
  files = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
}

if (files.length === 0) {
  ok("没有待提交的文件");
  console.log("==================================");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. 未跟踪的新文件
// ---------------------------------------------------------------------------

const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
if (untracked.length > 0) {
  warn("发现未跟踪文件:", untracked);
}

// ---------------------------------------------------------------------------
// 3. 调试残留
// ---------------------------------------------------------------------------

// 调试残留只检查代码文件
const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".c", ".cpp", ".h",
  ".java", ".kt", ".swift", ".sh", ".bash", ".zsh",
]);

const debugPatterns: { label: string; pattern: RegExp }[] = [
  { label: "console.log",    pattern: /console\.log\s*\(/ },
  { label: "console.warn",   pattern: /console\.warn\s*\(/ },
  { label: "console.error",  pattern: /console\.error\s*\(/ },
  { label: "debugger",       pattern: /debugger/ },
  { label: "print()",        pattern: /print\s*\(\s*$/m },
  { label: "<!-- DEBUG -->", pattern: /<!-- DEBUG -->/ },
  { label: ".only()",        pattern: /\.only\s*\(/ },
  { label: "fdescribe",      pattern: /fdescribe\s*\(/ },
  { label: "fit",            pattern: /fit\s*\(/ },
];

for (const { label, pattern } of debugPatterns) {
  const hits: string[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    if (!CODE_EXTS.has(f.slice(f.lastIndexOf(".")))) continue;
    const content = execSync(`cat "${f}"`, { encoding: "utf-8", stdio: "pipe" }).trim();
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        hits.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 80)}`);
      }
    }
  }
  if (hits.length > 0) {
    err(`疑似调试代码 (${label}):`, hits);
  }
}

// ---------------------------------------------------------------------------
// 4. 合并冲突标记
// ---------------------------------------------------------------------------

const conflictPattern = /^(<<<<<<<|=======|>>>>>>>)/;
const conflictHits: string[] = [];
for (const f of files) {
  if (!existsSync(f)) continue;
  if (!CODE_EXTS.has(f.slice(f.lastIndexOf(".")))) continue;
  const content = execSync(`cat "${f}"`, { encoding: "utf-8", stdio: "pipe" }).trim();
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (conflictPattern.test(lines[i])) {
      conflictHits.push(`${f}:${i + 1}: ${lines[i].trim()}`);
    }
  }
}
if (conflictHits.length > 0) {
  err("合并冲突未解决:", conflictHits);
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
  err("疑似敏感文件:", sensitiveFiles);
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
    bigFiles.push(`${f} (${mb} MB)`);
  }
}
if (bigFiles.length > 0) {
  warn("超大文件 (>1MB):", bigFiles);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log("==================================");
if (errors > 0) {
  console.log(`[ERROR] 检查不通过: ${errors} 个错误, ${warnings} 个警告`);
  console.log("请修复错误后再提交");
  process.exit(1);
} else if (warnings > 0) {
  console.log(`[WARN] 检查通过: ${warnings} 个警告`);
  console.log("建议人工确认后继续");
  process.exit(0);
} else {
  ok("检查全部通过");
  process.exit(0);
}
