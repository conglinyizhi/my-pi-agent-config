// 浏览器壳的静态演示数据。它只验证 View/平台边界，不模拟或裁决真实权限。

const auditRules = [
  { name: "递归删除", tip: "递归删除会永久移除路径内容", matched: ["rm", "-rf"] },
  { name: "提权", tip: "sudo 会以更高权限执行", matched: ["sudo"] },
];

export const browserFixtures = {
  gate: (() => {
    const command = 'OUT="$HOME/build" && KEEP=1 SRC=$(pwd) sudo rm -rf "$OUT"';
    const note = (raw, extra) => ({
      ...extra,
      raw,
      start: command.indexOf(raw),
      end: command.indexOf(raw) + raw.length,
    });
    return {
      command,
      taskId: "browser-preview",
      rules: auditRules,
      // 赋值解析：前两条能解析（绿框，悬停看值），带命令替换的解析不了（灰框，悬停看原因）
      envNotes: [
        note('OUT="$HOME/build"', { name: "OUT", value: "/home/tester/build" }),
        note("KEEP=1", { name: "KEEP", value: "1" }),
        note("SRC=$(pwd)", { name: "SRC", reason: "值里含命令替换 $(...)，无法静态解析" }),
      ],
      review: {
        verdict: "risky",
        reason: "提权：风险 0.95 > 0.5（privileged-change）；整体可疑：风险 0.75 > 0.5（3.00）",
        suggestion: "以上维度的判断超过阈值。分类模型精度有限，确认命令与你的意图一致再批准。",
        // 分类模型权重表（真实探针的形态）：风险降序，越线的行会标底色
        dimensions: [
          { id: "elevation", label: "提权", type: "choice", risk: 0.95, confidence: 0.72, raw: "privileged-change（直接改系统级权限）", triggered: true, reason: "风险 0.95 > 0.5", above: 0.5, below: 0.5, choice: "privileged-change", probabilities: { none: 0.05, "user-elevation": 0.15, "privileged-change": 0.8 } },
          { id: "oddity", label: "整体可疑", type: "score", risk: 0.75, confidence: 0.6, raw: "3.00（明显异常或超出常规操作）", triggered: true, reason: "风险 0.75 > 0.5", above: 0.5, below: 0.5, score: 3 },
          { id: "preshell_trust", label: "解析可信", type: "choice", risk: 0.4, confidence: 0.55, raw: "blind-spots（含命令替换）", triggered: false, reason: "", above: 0.5, below: 0.5, choice: "blind-spots", probabilities: { trustworthy: 0.6, "blind-spots": 0.4, opaque: 0 } },
          { id: "scripted_edit", label: "脚本改写", type: "noul", risk: 0.08, raw: "8%", triggered: false, reason: "", above: 0.5, below: null, noul: 0.08 },
          { id: "network", label: "网络", type: "choice", risk: 0.01, confidence: 0.9, raw: "none（纯本地操作）", triggered: false, reason: "", above: 0.5, below: 0.5, choice: "none", probabilities: { none: 0.99, "fetch-only": 0.01, upload: 0 } },
        ],
      },
      // 变量渲染值：target 是命令里的文本片段（无偏移，前端自己定位）
      varRenders: [
        { name: "SRC", target: "$(pwd)", source: "assignment", kind: "Exec", known: false, reason: "值里含命令替换 $(...)，无法静态解析" },
        { name: "HOME", value: "/home/tester", source: "env", target: "$HOME", kind: "Exec", known: true },
        { name: "OUT", value: "/home/tester/build", source: "assignment", target: "$OUT", kind: "Exec", known: true },
      ],
      kind: "audit",
    };
  })(),
  "gate-sandbox-allow": {
    command: "install -m 755 /tmp/build/bin/tool /usr/local/bin/tool",
    kind: "sandbox-allow",
    permission: "write-paths",
    writePaths: ["/usr/local/bin", "/opt/cache"],
    candidatePaths: ["/usr/local/bin", "/opt/cache"],
    justification: "需要把编译产物安装到系统 PATH 目录",
    persistentRoots: ["/home/test/.pnpm"],
    sessionWriteRoots: ["/tmp/session-build"],
    sessionTrustedRoots: ["/tmp/session-trusted"],
    builtinRoots: ["/workspace/demo", "/tmp"],
    workspaceRoot: "/workspace/demo",
    homeDir: "/home/test",
    rules: [],
  },
  subagents: {
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
