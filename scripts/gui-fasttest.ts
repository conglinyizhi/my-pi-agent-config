#!/usr/bin/env node
// build:gui-fasttest — 逐个启动 GUI，等待关闭，检查响应，一个失败就停
//
// 用法：node scripts/gui-fasttest.mjs

import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 60_000; // 每个 GUI 最多等 60 秒

// 找 electron
let electronBin: string;
try {
  const bins = execSync("ls /usr/bin/electron* 2>/dev/null", { encoding: "utf-8" })
    .trim().split("\n").filter(Boolean).sort().reverse();
  electronBin = bins[0];
} catch {
  console.error("❌ 未找到 electron。请安装：yay -S electron");
  process.exit(1);
}

const tests: Array<{ name: string; appJs: string; request: unknown }> = [
  {
    name: "review",
    appJs: join(ROOT, "extensions/trident-queue/gui-review/app.js"),
    request: {
      texts: [
        "**title**: 测试任务\n**goal**: 验证 GUI 确认流程\n**constraints**: 无\n**user_signals**: 未识别\n**context**: 这是一条测试发言",
      ],
    },
  },
  {
    name: "manager",
    appJs: join(ROOT, "extensions/trident-queue/gui-manager/app.js"),
    request: {
      tasks: [
        {
          id: "test-task",
          title: "测试任务",
          status: "executing",
          created_at: "2025-07-29T12:00:00+08:00",
          context: "## 已完成\n做了测试\n\n## 已修改文件\n- test.ts",
        },
      ],
    },
  },
  {
    name: "setup",
    appJs: join(ROOT, "extensions/trident-queue/gui/app.js"),
    request: {
      models: [{ value: "test/test-model", name: "Test Model" }],
      roles: { oc: "test/test-model", translator: "test/test-model", worker: "test/test-model" },
    },
  },
  {
    name: "gate",
    appJs: join(ROOT, "extensions/permission-gate/gui/app.js"),
    request: {
      command: "rm -rf /tmp/test",
      taskId: "test-task-001",
      rules: [{ pattern: "rm -rf", tip: "危险删除操作", autoReject: false }],
    },
  },
  {
    name: "route",
    appJs: join(ROOT, "extensions/trident-routing/gui/app.js"),
    request: {
      todos: [{ file: "test.ts", line: 10, text: "TODO: implement this" }],
      cwd: "/tmp",
    },
  },
  {
    name: "editor",
    appJs: join(ROOT, "extensions/editor-gui/gui/app.js"),
    request: { clipHistory: [], file: null },
  },
];

async function runGui(name: string, appJs: string, request: unknown): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-guitest-"));
  const reqFile = join(tmpDir, "request.json");
  const resFile = join(tmpDir, "response.json");

  writeFileSync(reqFile, JSON.stringify(request));

  return new Promise((resolve, reject) => {
    const proc = spawn(electronBin, [appJs, reqFile, resFile], {
      stdio: "ignore",
      detached: true,
    });

    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      reject(new Error("超时"));
    }, TIMEOUT);

    proc.on("close", () => {
      setTimeout(() => {
        clearTimeout(timer);
        try {
          if (existsSync(resFile)) {
            const action = JSON.parse(readFileSync(resFile, "utf-8")).action || "ok";
            resolve(action);
          } else {
            reject(new Error("无响应文件"));
          }
        } catch {
          reject(new Error("无响应文件"));
        } finally {
          try { rmSync(tmpDir, { recursive: true }); } catch {}
        }
      }, 200);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      try { rmSync(tmpDir, { recursive: true }); } catch {}
      reject(err);
    });
  });
}

console.log("");
console.log("⚓ GUI 快速测试");
console.log("===============");
console.log("");

let pass = 0;
let fail = 0;

for (const { name, appJs, request } of tests) {
  process.stdout.write(`  ${name} ... `);
  try {
    const action = await runGui(name, appJs, request);
    console.log(`✅ (action=${action})`);
    pass++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`❌ ${msg}`);
    fail++;
    break; // 一个失败就停
  }
}

console.log("");
console.log("===============");
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log("");

process.exit(fail > 0 ? 1 : 0);
