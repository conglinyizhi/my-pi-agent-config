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
          task: "重构 lib/scheduler.ts：把调度循环与状态持久化拆成两个模块，保持现有 6 个测试全部通过且零回归，并处理并发 tick 的竞态",
          model: "test/test-model",
          status: "running",
          startedAt: "2025-07-29T12:00:00+08:00",
          pid: 1234,
          timeline: [
            {
              id: "lifecycle-start-1",
              type: "lifecycle",
              ts: "2025-07-29T12:00:00+08:00",
              state: "starting",
              message: "worker 启动，读取任务上下文并规划重构步骤",
            },
            {
              id: "tool-read-1",
              type: "tool",
              ts: "2025-07-29T12:00:01+08:00",
              tool: "read",
              args: "{\"path\":\"lib/scheduler.ts\",\"offset\":1,\"limit\":400}",
            },
            {
              id: "assistant-plan",
              type: "assistant",
              ts: "2025-07-29T12:00:03+08:00",
              text: "已经读完 scheduler.ts 的前 400 行。当前调度循环把「取任务」「跑 worker」「写状态」「触发轮询」全塞在一个 while 循环里，竞态点集中在状态持久化与 poll 之间：\n\n1. tick 里先写盘再触发 poll，但 poll 读到的可能是旧快照；\n2. worker 结束与状态写入之间没有锁，两个 tick 并发时会互相覆盖 finishedAt；\n3. 建议把状态持久化抽成独立的 store 模块，调度循环只负责派发。\n\n接下来先拆 store，再改循环，最后补并发测试。",
              final: false,
            },
            {
              id: "tool-bash-1",
              type: "tool",
              ts: "2025-07-29T12:00:05+08:00",
              tool: "bash",
              args: "{\"command\":\"grep -n 'persist|poll|while' lib/scheduler.ts\"}",
              preview: "  12:    while (running) {\n  14:      const task = await store.next();\n  18:      await store.persist(snapshot);\n  21:      poll.notify();\n  37:    }\n  41:  async persist(s) { ... }\n  88:  poll.on('tick', ...)",
            },
            {
              id: "lifecycle-running-1",
              type: "lifecycle",
              ts: "2025-07-29T12:00:06+08:00",
              state: "running",
              message: "已确认竞态点，开始拆分 store 模块",
            },
            {
              id: "tool-edit-1",
              type: "tool",
              ts: "2025-07-29T12:00:08+08:00",
              tool: "edit",
              args: "{\"file\":\"lib/scheduler.ts\",\"edits\":[{\"oldText\":\"while (running)\",\"newText\":\"while (running && !cancelled)\"},{\"oldText\":\"await store.persist(snapshot)\",\"newText\":\"await store.commit(snapshot)\"}]}",
              preview: "--- a/lib/scheduler.ts\n+++ b/lib/scheduler.ts\n@@ -12,7 +12,7 @@\n-    while (running) {\n+    while (running && !cancelled) {\n@@ -18,7 +18,7 @@\n-      await store.persist(snapshot);\n+      await store.commit(snapshot);",
              result: "applied 2 edits",
              ok: true,
            },
            {
              id: "assistant-mid-1",
              type: "assistant",
              ts: "2025-07-29T12:00:10+08:00",
              text: "store.commit 已接入，调度循环不再直接写盘。还剩两件事：把 poll 通知改成监听 commit 事件，以及为并发场景补一条测试。处理完这两项再跑全量测试。",
              final: false,
            },
          ],
        },
        {
          id: "w2",
          task: "为 subagents 三级浏览补全 readerEvents 边界测试，覆盖 output/stderr 合成记录并输出长摘要",
          model: "test/test-model",
          status: "success",
          startedAt: "2025-07-29T12:00:01+08:00",
          finishedAt: "2025-07-29T12:00:10+08:00",
          output: "✓ 边界测试通过（node --test src/subagent-reader.test.js）\n  测试 9 个 / 通过 9 个\n  - readerEvents 保留 timeline 顺序并在末尾追加合成 terminal 记录\n  - output 与 stderr 生成互不碰撞的 synthetic-terminal-* ID\n  - 空字符串与纯空白不生成记录；非字符串值一律跳过\n  - 入参数组不被变异，对象引用保持不变\n  - adjacentEventId 越界/未知 ID/非法方向均返回 null\n✓ 覆盖率：statements 100%, functions 100%, branches 100%, lines 100%\n✓ 无回归：全量单测 42/42 通过",
          usage: { turns: 9, input: 48213, output: 15240, cacheRead: 6, cacheWrite: 2, cost: 0.0421 },
          timeline: [
            {
              id: "lifecycle-start-2",
              type: "lifecycle",
              ts: "2025-07-29T12:00:01+08:00",
              state: "starting",
              message: "worker 启动，读取 reader 模块与现有测试",
            },
            {
              id: "tool-read-2",
              type: "tool",
              ts: "2025-07-29T12:00:02+08:00",
              tool: "read",
              args: "{\"path\":\"src/subagent-reader.js\",\"offset\":1,\"limit\":200}",
              result: "const TERMINAL_PREFIX = 'synthetic-terminal';\nconst TERMINAL_OUTPUT_ID = `${TERMINAL_PREFIX}-output`;\nconst TERMINAL_STDERR_ID = `${TERMINAL_PREFIX}-stderr`;\n\nexport function readerEvents(worker) {\n  const timeline = Array.isArray(worker?.timeline) ? worker.timeline : [];\n  const events = [...timeline];\n  const used = new Set(events.map((event) => event.id));\n  if (hasText(worker?.output)) {\n    events.push({ id: uniqueTerminalId(TERMINAL_OUTPUT_ID, used), type: 'terminal', stream: 'output', text: worker.output });\n  }\n  if (hasText(worker?.stderr)) {\n    events.push({ id: uniqueTerminalId(TERMINAL_STDERR_ID, used), type: 'terminal', stream: 'stderr', text: worker.stderr });\n  }\n  return events;\n}",
              ok: true,
            },
            {
              id: "assistant-summary-2",
              type: "assistant",
              ts: "2025-07-29T12:00:05+08:00",
              text: "readerEvents 的合成记录逻辑已经看明白：timeline 原样保留，只在末尾按 output → stderr 顺序追加非空 terminal 记录，ID 用 stable 前缀并做去重。现有测试已覆盖「空字符串不生成记录」「保持对象引用不变」「合成 ID 碰撞兜底」三条关键路径，没有发现漏测的边界。\n\n结论：不需要新增断言，直接补齐 fixture 里的长文本即可让三级详情页挂载长内容。",
              final: true,
            },
            {
              id: "tool-edit-2",
              type: "tool",
              ts: "2025-07-29T12:00:06+08:00",
              tool: "edit",
              args: "{\"file\":\"scripts/gui-fasttest.ts\",\"edits\":[{\"oldText\":\"output: '修复完成'\",\"newText\":\"output: 长摘要\"}]}",
              preview: "--- a/scripts/gui-fasttest.ts\n+++ b/scripts/gui-fasttest.ts\n@@ -62,7 +62,7 @@\n-          output: \"修复完成\",\n+          output: \"✓ 边界测试通过（node --test src/subagent-reader.test.js）\\n...\",",
              result: "ok",
              ok: true,
            },
            {
              id: "lifecycle-success-2",
              type: "lifecycle",
              ts: "2025-07-29T12:00:10+08:00",
              state: "success",
              message: "worker 完成，全部验收通过",
            },
          ],
        },
        {
          id: "w3",
          task: "运行 wails-gui 前端类型检查与单元测试，定位 flaky 的渲染断言（预期失败：用于验证失败路径展示）",
          model: "test/test-model",
          status: "failed",
          startedAt: "2025-07-29T12:00:02+08:00",
          finishedAt: "2025-07-29T12:00:09+08:00",
          stderr: "Error: AssertionError [ERR_ASSERTION]: expected timeline row count 8, got 7\n    at file:///src/views/SubagentsView.test.js:88:5\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)\n    at async run (file:///src/views/SubagentsView.test.js:102:9)\n  ● SubagentsView › 时间线渲染 › 每次轮询后跟随底部\n    expected 8 rows but only 7 rendered，1 行因虚拟滚动视口高度计算差一行\n    → 怀疑 viewportH 在 ResizeObserver 首次回调前为 0，导致 endIndex 少算一行\n    → 建议 measure() 在挂载后立即补一次，而非等 observer 回调\n  node --test 退出码 1（期望 0）",
          timeline: [
            {
              id: "lifecycle-start-3",
              type: "lifecycle",
              ts: "2025-07-29T12:00:02+08:00",
              state: "starting",
              message: "worker 启动，准备执行前端测试",
            },
            {
              id: "tool-test-3",
              type: "tool",
              ts: "2025-07-29T12:00:03+08:00",
              tool: "bash",
              args: "{\"command\":\"node --test src/views/SubagentsView.test.js\"}",
              result: "exit 1\nAssertionError [ERR_ASSERTION]: expected 8 got 7\n    at SubagentsView.test.js:88:5\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)\n● 时间线渲染 › 每次轮询后跟随底部\n  expected 8 rows but only 7 rendered（虚拟滚动 endIndex 少算一行）\nnode --test 退出码 1",
              ok: false,
            },
            {
              id: "assistant-debug-3",
              type: "assistant",
              ts: "2025-07-29T12:00:06+08:00",
              text: "测试失败的原因基本锁定：时间线行数差一行，说明虚拟滚动的 endIndex 计算偏小。最可疑的是 ResizeObserver 首帧回调前 viewportH 仍是 0，endIndex 按 0 高度算出来少渲染一行。\n\n下一步先加一个挂载后立即 measure 的补丁，再跑同一组测试确认行数恢复为 8。如果还差，再看 OVERSCAN 的常数是否需要跟视口高度联动。",
              final: false,
            },
            {
              id: "lifecycle-failed-3",
              type: "lifecycle",
              ts: "2025-07-29T12:00:09+08:00",
              state: "failed",
              message: "worker 失败：断言未通过，等待人工确认修复方向",
            },
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
