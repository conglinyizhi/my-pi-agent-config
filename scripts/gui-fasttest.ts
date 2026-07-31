#!/usr/bin/env node
// test:gui — 并行启动全部 GUI，自动判定渲染就绪/主进程异常，全量报告
//
// 用法：node scripts/gui-fasttest.ts

import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 30_000; // 每个 GUI 最多等 30 秒

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
    appJs: join(ROOT, "extensions/trident-queue/gui-review/app.mjs"),
    request: {
      texts: [
        "**title**: 测试任务\n**goal**: 验证 GUI 确认流程\n**constraints**: 无\n**user_signals**: 未识别\n**context**: 这是一条测试发言",
      ],
    },
  },
  {
    name: "manager",
    appJs: join(ROOT, "extensions/trident-queue/gui-manager/app.mjs"),
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
    appJs: join(ROOT, "extensions/trident-queue/gui/app.mjs"),
    request: {
      models: [{ value: "test/test-model", name: "Test Model" }],
      roles: { oc: "test/test-model", translator: "test/test-model", worker: "test/test-model" },
    },
  },
  {
    name: "gate",
    appJs: join(ROOT, "extensions/permission-gate/gui/app.mjs"),
    request: {
      command: "rm -rf /tmp/test",
      taskId: "test-task-001",
      rules: [{ pattern: "rm -rf", tip: "危险删除操作", autoReject: false }],
    },
  },
  {
    name: "route",
    appJs: join(ROOT, "extensions/trident-routing/gui/app.mjs"),
    request: {
      todos: [{ file: "test.ts", line: 10, text: "TODO: implement this" }],
      cwd: "/tmp",
    },
  },
  {
    name: "editor",
    appJs: join(ROOT, "extensions/editor-gui/gui/app.mjs"),
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
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let outBuf = "";
    proc.stdout.on("data", (d) => { outBuf += d.toString(); });
    proc.stderr.on("data", (d) => { outBuf += d.toString(); });

    // 自动判定：轮询 ready/error sidecar，不再依赖人工操作关闭窗口
    const readyFile = `${resFile}.ready`;
    const errFile = `${resFile}.error`;
    const started = Date.now();
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      try { proc.kill("SIGTERM"); } catch {}
      fn();
      try { rmSync(tmpDir, { recursive: true }); } catch {}
    };

    const poll = setInterval(() => {
      if (existsSync(errFile)) {
        const errMsg = readFileSync(errFile, "utf-8").split("\n")[0] || "未知主进程异常";
        finish(() => reject(new Error(`主进程异常：${errMsg}`)));
        return;
      }
      if (existsSync(readyFile)) {
        const status = readFileSync(readyFile, "utf-8");
        if (status === "ok") {
          finish(() => resolve("ready"));
        } else {
          finish(() => reject(new Error(`渲染异常：#app 未挂载（status=${status}）`)));
        }
        return;
      }
      if (Date.now() - started > TIMEOUT) {
        finish(() => reject(new Error(`超时（${TIMEOUT / 1000}s）：无 ready/error 信号${outBuf ? "\n" + outBuf.trim() : ""}`)));
      }
    }, 200);

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`超时（${TIMEOUT / 1000}s）${outBuf ? "\n" + outBuf.trim() : ""}`)));
    }, TIMEOUT);

    proc.on("close", () => {
      // 进程提前退出（如启动即崩）：若已有 sidecar 则由 poll 处理，否则报错
      setTimeout(() => {
        if (settled) return;
        if (existsSync(errFile)) {
          const errMsg = readFileSync(errFile, "utf-8").split("\n")[0] || "未知主进程异常";
          finish(() => reject(new Error(`主进程异常：${errMsg}`)));
        } else if (existsSync(readyFile)) {
          const status = readFileSync(readyFile, "utf-8");
          if (status === "ok") finish(() => resolve("ready"));
          else finish(() => reject(new Error(`渲染异常：#app 未挂载（status=${status}）`)));
        } else {
          finish(() => reject(new Error(`进程提前退出，无响应${outBuf ? "\n" + outBuf.trim() : ""}`)));
        }
      }, 300);
    });

    proc.on("error", (err) => {
      finish(() => reject(err));
    });
  });
}

console.log("");
console.log("⚓ GUI 快速测试");
console.log("===============");
console.log("");

let pass = 0;
let fail = 0;

// 并行启动全部 GUI，全量报告（不再一个失败就停）
const results = await Promise.allSettled(
  tests.map(async ({ name, appJs, request }) => {
    try {
      const action = await runGui(name, appJs, request);
      return { name, action };
    } catch (err) {
      // 把 GUI 名带进错误信息，失败行才能显示是哪个 GUI
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${name}: ${msg}`);
    }
  })
);

for (const r of results) {
  if (r.status === "fulfilled") {
    const { name, action } = r.value;
    console.log(`  ${name} ... ✅ 渲染就绪 (${action})`);
    pass++;
  } else {
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    console.log(`  ❌ ${msg}`);
    fail++;
  }
}

console.log("");
console.log("===============");
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log("");

process.exit(fail > 0 ? 1 : 0);
