// 浏览器壳的静态演示数据。它只验证 View/平台边界，不模拟或裁决真实权限。

const auditRules = [
  { name: "递归删除", tip: "递归删除会永久移除路径内容", matched: ["rm", "-rf"] },
  { name: "提权", tip: "sudo 会以更高权限执行", matched: ["sudo"] },
];

export const browserFixtures = {
  gate: {
    command: "sudo rm -rf ./build-cache",
    taskId: "browser-preview",
    rules: auditRules,
    review: { verdict: "risky", reason: "递归删除构建缓存需要确认范围", suggestion: "确认目标目录是否可安全重建" },
    kind: "audit",
  },
  subagents: {
    feedback: false,
    workers: [
      {
        id: "browser-w1", task: "检查浏览器壳的 View 平台边界", status: "running", model: "mock/browser", pid: 1001,
        usage: { turns: 2, input: 1400, output: 280 }, inboxId: "browser-w1",
        timeline: [
          { id: "l1", type: "lifecycle", state: "starting", ts: "2026-09-07T12:00:00.000Z" },
          { id: "a1", type: "assistant", text: "正在检查 adapter 接口。", final: true, ts: "2026-09-07T12:00:01.000Z" },
          { id: "t1", type: "tool", tool: "read", args: "src/platform/browser.js", ok: true, result: "mock result", ts: "2026-09-07T12:00:02.000Z" },
        ],
        supplements: [{ id: "s1", text: "注意不要引入 Wails binding", state: "pending" }],
      },
    ],
  },
  routing: {
    cwd: "/workspace/demo",
    todos: [
      { file: "src/platform/browser.js", line: 1, text: "接入 HTTP / SSE adapter", done: false },
      { file: "README.md", line: 20, text: "补充浏览器壳说明", done: false },
      { file: "old.ts", line: 8, text: "历史完成项", done: true },
    ],
  },
  editor: {
    clipHistory: ["把浏览器壳接到 mock fixture", "<response>保留平台边界</response>"],
  },
};
