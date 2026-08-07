#!/usr/bin/env node
// test:gui — 并行启动全部 GUI，自动判定渲染就绪/主进程异常，全量报告
//
// 用法：node scripts/gui-fasttest.ts

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { findGuiBinary } from "../lib/gui-runner.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 30_000; // 每个 GUI 最多等 30 秒

// 找 wails-gui 二进制
const guiBin = findGuiBinary();
if (!guiBin) {
  console.error("❌ 未找到 wails-gui。请先构建：cd wails-gui && wails build -tags webkit2_41");
  process.exit(1);
}

const tests: Array<{ name: string; windowName: string; request: unknown }> = [
  {
    name: "subagents",
    windowName: "subagents",
    request: {
      feedback: false,
      workers: [
        {
          id: "w1",
          task: "测试任务：扫描 src 目录",
          model: "test/test-model",
          status: "running",
          startedAt: "2025-07-29T12:00:00+08:00",
          pid: 1234,
          timeline: [
            { id: "lifecycle-1", type: "lifecycle", ts: "2025-07-29T12:00:00+08:00", state: "starting", message: "worker 启动" },
            { id: "tool-read", type: "tool", ts: "2025-07-29T12:00:01+08:00", tool: "read", args: "{\"path\":\"src/index.ts\"}" },
            { id: "assistant-1", type: "assistant", ts: "2025-07-29T12:00:03+08:00", text: "正在扫描 src 目录结构，稍后汇总……", final: false },
            { id: "tool-bash", type: "tool", ts: "2025-07-29T12:00:04+08:00", tool: "bash", args: "{\"command\":\"ls src/\"}", preview: "index.ts\nutils/" },
          ],
        },
        {
          id: "w2",
          task: "测试任务：修复 be-* 错误",
          model: "test/test-model",
          status: "success",
          startedAt: "2025-07-29T12:00:01+08:00",
          finishedAt: "2025-07-29T12:00:10+08:00",
          output: "修复完成",
          timeline: [
            { id: "lifecycle-1", type: "lifecycle", ts: "2025-07-29T12:00:01+08:00", state: "starting", message: "worker 启动" },
            { id: "tool-read", type: "tool", ts: "2025-07-29T12:00:02+08:00", tool: "read", args: "{\"path\":\"src/be.ts\"}", result: "export function be() {}", ok: true },
            { id: "assistant-1", type: "assistant", ts: "2025-07-29T12:00:05+08:00", text: "发现 be() 未处理空参数，准备修复。", final: true },
            { id: "tool-edit", type: "tool", ts: "2025-07-29T12:00:06+08:00", tool: "edit", args: "{\"file\":\"src/be.ts\",\"edits\":1}", preview: "已应用 1 处修改", result: "ok", ok: true },
            { id: "lifecycle-2", type: "lifecycle", ts: "2025-07-29T12:00:10+08:00", state: "success", message: "worker 完成" },
          ],
        },
        {
          id: "w3",
          task: "测试任务：跑测试（预期失败）",
          model: "test/test-model",
          status: "failed",
          startedAt: "2025-07-29T12:00:02+08:00",
          finishedAt: "2025-07-29T12:00:08+08:00",
          stderr: "Error: assertion failed at line 42",
          timeline: [
            { id: "lifecycle-1", type: "lifecycle", ts: "2025-07-29T12:00:02+08:00", state: "starting", message: "worker 启动" },
            { id: "tool-test", type: "tool", ts: "2025-07-29T12:00:03+08:00", tool: "bash", args: "{\"command\":\"node test.js\"}", result: "exit 1\nassertion failed", ok: false },
            { id: "assistant-1", type: "assistant", ts: "2025-07-29T12:00:06+08:00", text: "测试失败，正在定位原因……", final: false },
            { id: "lifecycle-2", type: "lifecycle", ts: "2025-07-29T12:00:08+08:00", state: "failed", message: "worker 失败" },
          ],
        },
      ],
    },
  },
  {
    name: "setup",
    windowName: "setup",
    request: {
      models: [{ value: "test/test-model", name: "Test Model" }],
      roles: { oc: "test/test-model", worker: "test/test-model" },
    },
  },
  {
    name: "gate",
    windowName: "gate",
    request: {
      command: "rm -rf /tmp/test",
      taskId: "test-task-001",
      rules: [{ pattern: "rm -rf", tip: "危险删除操作", autoReject: false }],
    },
  },
  {
    name: "route",
    windowName: "routing",
    request: {
      todos: [{ file: "test.ts", line: 10, text: "TODO: implement this" }],
      cwd: "/tmp",
    },
  },
  {
    name: "editor",
    windowName: "editor",
    request: { clipHistory: [], file: null },
  },
];

async function runGui(name: string, windowName: string, request: unknown): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-guitest-"));
  const reqFile = join(tmpDir, "request.json");
  const resFile = join(tmpDir, "response.json");

  writeFileSync(reqFile, JSON.stringify(request));

  return new Promise((resolve, reject) => {
    const proc = spawn(guiBin, [windowName, reqFile, resFile], {
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
  tests.map(async ({ name, windowName, request }) => {
    try {
      const action = await runGui(name, windowName, request);
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
