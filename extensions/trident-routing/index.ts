// trident-routing — 主Agent（林汐）工具权限控制
//
// 航母不亲自出击。禁止主Agent使用 write/edit 工具，
// 强制她通过 translate_task / task_create / subagent 调度工作。
// 
// /homeport 指令可临时解除限制，用于开发调试。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { spawn, execSync } from "node:child_process";
import { scanTodos, type TodoItem, type ScanState } from "./todo-scan";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DISABLED_TOOLS = new Set<string>([
  // 林汐保留完整能力：write、edit、bash、MCP 全系列
  // 小活自己干，大活走 task_create 分发支线任务
]);

// 开场白：说人话，先落点；在场不报到，环境点到为止。
// 禁止系统腔；禁止未查证的队列/进度/归档等完成态（开场时尚未读事项，不许谎报军情）。
// 环境句不要硬接业务排期；观察停住，或只接到「进来/坐下/不急」。
const GREETINGS = [
  // 交接（不问未经验证的状态，只抛选择）
  "今天有什么新计划……还是先聊会儿？",
  "先排期，还是先闲聊？",
  "从哪开始，你定",
  // 环境（观察或接到空间，不接到办事顺序）
  "甲板风有点凉，进来吧，简报室暖和",
  "外面在下雨，不急的话先坐会儿也行",
  "雾挺大的，不急",
  "外面雾挺大，进来再说",
  // 在场（轻，不点名报到）
  "提督",
  "嗯，来了，说吧",
  "你来了，不急，想到什么再说",
  // 关心（克制；不替对方诊断，不假装已扫队列）
  "咖啡在你右手边，缓一下也行",
  "要是还没缓过来，先歇着也行，有事再开口",
  "不急着上，你准备好了再说",
  // 任务向（口语；小活自己动手，大活分发支线）
  "今天想先动哪一块？小活林汐直接来，大活派下去",
  "有目标就丢过来，林汐判断自己上还是起支线",
  "要过事项就说一声，林汐再去查",
  // 航母接活（分发支线是核心能力）
  "编组的事可以交给林汐，你先说目标",
  "要开会就开会，要派工就派工，你开口",
];

let skipNextGreeting = false;
let homeportSession = false;

async function enterHomeport(pi: ExtensionAPI, ctx: any) {
  skipNextGreeting = true;
  homeportSession = true;
  ctx.ui.notify("⚓ 返回母港。本会话不限制工具，可自由编辑。", "info");
  await ctx.newSession({
    withSession: async (c: any) => {
      c.ui.notify("已进入母港。write/edit 可用，subagent 已禁用。", "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  // 子进程内不限制工具，worker 需要 MCP 编辑能力
  if (process.env.PI_SUBAGENT) return;
  pi.on("session_start", async (event, ctx) => {
    // 启动时在 pi 配置目录 → 询问是否进母港
    if (event.reason === "startup" && ctx.cwd === getAgentDir()) {
      const ok = await ctx.ui.confirm(
        "⚓ 进入母港？",
        "检测到你在 pi 配置目录。要进入母港模式维修林汐吗？（母港模式保留 write/edit，禁用 subagent）"
      );
      if (ok) {
        homeportSession = true;
        ctx.ui.notify("已进入母港。write/edit 可用，subagent 已禁用。", "info");
        // 禁用 subagent
        const active = pi.getActiveTools();
        const filtered = active.filter((t: string) => t !== "subagent");
        if (filtered.length !== active.length) pi.setActiveTools(filtered);
        return; // 跳过正常 startup 的限制逻辑
      }
    }

    const isHomeport = event.reason === "new" && skipNextGreeting;
    skipNextGreeting = false;

    // 非母港：限制 write/edit
    if (!isHomeport) {
      homeportSession = false;
      const active = pi.getActiveTools();
      const filtered = active.filter((t: string) => !DISABLED_TOOLS.has(t));
      if (filtered.length !== active.length) {
        pi.setActiveTools(filtered);
      }
    } else {
      // 母港：禁用 subagent
      const active = pi.getActiveTools();
      const filtered = active.filter((t: string) => t !== "subagent");
      if (filtered.length !== active.length) pi.setActiveTools(filtered);
    }

    // 新会话时注入开场白（母港模式跳过）
    if ((event.reason === "new" || event.reason === "startup") && !isHomeport) {
      const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      pi.sendMessage({
        customType: "trident-greeting",
        content: greeting,
        display: true,
      });
    }
  });

  pi.registerCommand("homeport", {
    description: "返回母港：创建无限制的新会话（保留 write/edit，跳过开场白）",
    handler: async (args, ctx) => {
      await enterHomeport(pi, ctx);
    },
  });

  // 母港模式：替换系统提示词
  pi.on("before_agent_start", (event) => {
    if (!homeportSession) return;
    const promptPath = join(__dirname, "homeport-prompt.md");
    const prompt = existsSync(promptPath) ? readFileSync(promptPath, "utf-8") : "直接编码助手。";
    return { systemPrompt: prompt };
  });

  // ═══════════════════════════════════════════════════
  // TODO 扫描 + Widget + 命令
  // ═══════════════════════════════════════════════════

  const WIDGET_ID = "todo-scanner";
  let todoState: ScanState = { status: "idle" };

  function buildTodoWidget(state: ScanState) {
    return (_tui: unknown, theme: any) => ({
      render(_width: number): string[] {
        if (state.status === "scanning") return [theme.fg("dim", "📋 TODO: 扫描中…")];
        if (state.status === "timeout") return [theme.fg("error", "📋 TODO: 扫描超时")];
        if (state.status === "error") return [theme.fg("warning", `📋 TODO: ${state.message}`)];
        if (state.status === "idle") return [];
        if (state.total === 0) return [theme.fg("success", "📋 TODO(s): 0/0 ✓")];
        if (state.doneCount === state.total) return [theme.fg("success", `📋 TODO(s): ${state.doneCount}/${state.total} ✓`)];
        return [theme.fg("accent", `📋 TODO(s): ${state.doneCount}/${state.total}`) + theme.fg("dim", "  /scan-todo 展开")];
      },
      invalidate() {},
    });
  }

  async function refreshTodos(ctx: any) {
    todoState = { status: "scanning" };
    ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState));
    const result = await scanTodos(pi, ctx.cwd);
    if (result === null) { todoState = { status: "timeout" }; ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState)); return; }
    todoState = { status: "done", ...result, expanded: false };
    ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState));
    pi.events.emit("todo-scanner:result", { count: result.total, done: result.doneCount });
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) await refreshTodos(ctx);
  });

  pi.registerCommand("scan-todo", {
    description: "打开 TODO 调度 GUI：选中、定位文件、补充说明后发送",
    handler: async (_args: string, ctx: any) => {
      if (!ctx.hasUI) return;
      await refreshTodos(ctx);
      if (todoState.status !== "done") { ctx.ui.notify("TODO 扫描失败", "error"); return; }

      const todos = todoState.items;
      if (todos.length === 0) { ctx.ui.notify("没有 TODO", "info"); return; }

      // 找 electron
      let electronBin: string | null = null;
      try {
        const bins = execSync("ls /usr/bin/electron* 2>/dev/null", { encoding: "utf-8" })
          .trim().split("\n").filter(Boolean).sort().reverse();
        electronBin = bins[0] || null;
      } catch {}
      if (!electronBin) { ctx.ui.notify("未找到 electron", "error"); return; }

      const guiDir = join(os.homedir(), ".pi", "agent", "extensions", "trident-routing", "gui");
      const appJs = join(guiDir, "app.js");
      const distHtml = join(guiDir, "dist", "index.html");
      if (!existsSync(appJs) || !existsSync(distHtml)) {
        ctx.ui.notify("GUI 未构建。执行 pnpm build:gui-route", "error");
        return;
      }

      const tmpDir = mkdtempSync(join(os.tmpdir(), "todo-gui-"));
      const reqFile = join(tmpDir, "request.json");
      const resFile = join(tmpDir, "response.json");
      writeFileSync(reqFile, JSON.stringify({ todos, cwd: ctx.cwd }));

      const proc = spawn(electronBin, [appJs, reqFile, resFile], { stdio: "ignore", detached: true });

      // 等 GUI 关闭
      const result = await new Promise<any>((resolve) => {
        const timer = setTimeout(() => resolve({ cancelled: true }), 300_000);
        const check = setInterval(() => {
          try {
            const data = JSON.parse(readFileSync(resFile, "utf-8"));
            clearTimeout(timer); clearInterval(check); resolve(data);
          } catch {}
        }, 200);
      });

      try { proc.kill("SIGTERM"); } catch {}

      if (!result || result.action === "cancel" || !result.todos?.length) return;

      const itemsBlock = result.todos.map((item: { file: string; line: number; text: string }) =>
        `- \`${item.file}:${item.line}\`\n  > ${item.text}`).join("\n");
      let msg = `处理以下 TODO:\n\n${itemsBlock}`;
      if (result.note) msg += `\n\n补充: ${result.note}`;
      pi.sendUserMessage(msg);
      ctx.ui.notify(`已发送 ${result.todos.length} 个 TODO`, "info");
    },
  });

  pi.registerShortcut("ctrl+shift+t", {
    description: "刷新 TODO 列表",
    handler: async (ctx) => { if (ctx.hasUI) await refreshTodos(ctx); },
  });
}
