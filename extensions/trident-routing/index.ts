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

const DISABLED_TOOLS = new Set(["write", "edit"]);

const GREETINGS = [
  "昨天的都归档了。今天有什么新计划……还是先聊会儿？",
  "甲板风有点凉。进来吧，简报室暖和。",
  "提督。咖啡在你右手边。有什么需要我调度的？",
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
      writeFileSync(reqFile, JSON.stringify({ todos }));

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
