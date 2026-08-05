// trident-routing — 主Agent（林汐）工具权限控制
//
// 林汐保留完整能力：write、edit、bash、MCP 全系列。
// 小活自己干，大活走 subagent 分发支线任务。
// 
// /homeport 指令可进入母港（维修模式）：替换系统提示词、跳过开场白。

import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { runGuiWindow, findGuiBinary } from "../../lib/gui-runner";
import { scanTodos, type TodoItem, type ScanState, type ScanTodosOptions } from "./todo-scan";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DISABLED_TOOLS = new Set<string>([
  // 林汐保留完整能力：write、edit、bash、MCP 全系列
  // 小活自己干，大活走 subagent 分发支线任务
]);

// 开场白：说人话，先落点；在场不报到，环境点到为止。
// 禁止系统腔；禁止未查证的队列/进度/归档等完成态（开场时尚未读事项，不许谎报军情）。
// 环境句不要硬接业务排期；观察停住，或只接到「进来/坐下/不急」。
const GREETINGS = [
  // 交接（不问未经验证的状态，只抛选择）
  "今天有什么新计划……还是先聊会儿？",
  "先排期，还是先闲聊？",
  "从哪开始，提督定",
  // 环境（观察或接到空间，不接到办事顺序）
  "甲板风有点凉，进来吧，简报室暖和",
  "外面在下雨，不急的话先坐会儿也行",
  "雾挺大的，不急",
  "外面雾挺大，进来再说",
  // 在场（轻，不点名报到）
  "提督",
  "嗯，来了，说吧",
  "提督来了，不急，想到什么再说",
  // 关心（克制；不替对方诊断，不假装已扫队列）
  "咖啡在提督右手边，缓一下也行",
  "要是还没缓过来，先歇着也行，有事再开口",
  "不急着上，提督准备好了再说",
  // 任务向（口语；小活自己动手，大活分发支线）
  "今天想先动哪一块？小活林汐直接来，大活派下去",
  "有目标就丢过来，林汐判断自己上还是起支线",
  "要过事项就说一声，林汐再去查",
  // 航母接活（分发支线是核心能力）
  "编组的事可以交给林汐，提督先说目标",
  "要开会就开会，要派工就派工，提督开口",
];

let skipNextGreeting = false;
let homeportSession = false;

async function enterHomeport(pi: ExtensionAPI, ctx: any) {
  skipNextGreeting = true;
  homeportSession = true;
  ctx.ui.notify("⚓ 返回母港。维修模式。", "info");
  await ctx.newSession({
    withSession: async (c: any) => {
      c.ui.notify("已进入母港。维修模式。", "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  // 子进程内不限制工具，worker 需要 MCP 编辑能力
  if (process.env.PI_SUBAGENT) return;

  // 开场白渲染：仅显示在 TUI，不进入 LLM 上下文。
  // 用 appendEntry（CustomEntry，不参与上下文）替代 sendMessage（CustomMessage，会被转成 user 消息发给 API）。
  const greetingRenderer: EntryRenderer<{ content?: string }> = (entry, _options, theme) => {
    const content = entry.data?.content;
    if (!content) return undefined;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("accent", "林汐: ") + theme.fg("customMessageText", content), 0, 0));
    return box;
  };
  pi.registerEntryRenderer("trident-greeting", greetingRenderer);

  pi.on("session_start", async (event, ctx) => {
    // 状态栏
    ctx.ui.setStatus("trident", ctx.ui.theme.fg("accent", "林汐"));

    // 启动时在 pi 配置目录 → 询问是否进母港
    if (event.reason === "startup" && ctx.cwd === getAgentDir()) {
      const ok = await ctx.ui.confirm(
        "⚓ 进入母港？",
        "检测到你在 pi 配置目录。要进入母港模式维修林汐吗？"
      );
      if (ok) {
        homeportSession = true;
        ctx.ui.setStatus("trident", ctx.ui.theme.fg("accent", "母港"));
        ctx.ui.notify("已进入母港。维修模式。", "info");
        return;
      }
    }

    const isHomeport = event.reason === "new" && skipNextGreeting;
    skipNextGreeting = false;

    // 状态栏：母港 / 林汐
    ctx.ui.setStatus("trident", ctx.ui.theme.fg("accent", isHomeport ? "母港" : "林汐"));

    // 当前不禁用任何工具（DISABLED_TOOLS 为空集：林汐保留完整能力）
    if (!isHomeport) {
      homeportSession = false;
      const active = pi.getActiveTools();
      const filtered = active.filter((t: string) => !DISABLED_TOOLS.has(t));
      if (filtered.length !== active.length) {
        pi.setActiveTools(filtered);
      }
    }

    // 新会话时注入开场白（母港模式跳过）—— 仅显示在 TUI，不进入 LLM 上下文
    if ((event.reason === "new" || event.reason === "startup") && !isHomeport) {
      const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      pi.appendEntry("trident-greeting", { content: greeting });
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
        if (state.status === "skipped") return [theme.fg("dim", "📋 TODO: ~ 目录跳过扫描")];
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

  async function refreshTodos(ctx: any, opts?: ScanTodosOptions) {
    todoState = { status: "scanning" };
    ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState));
    const result = await scanTodos(pi, ctx.cwd, opts);
    if (result === null) { todoState = { status: "timeout" }; ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState)); return; }
    if ("skipped" in result) { todoState = { status: "skipped" }; ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState)); return; }
    todoState = { status: "done", ...result, expanded: false };
    ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState));
    pi.events.emit("todo-scanner:result", { count: result.total, done: result.doneCount });
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) await refreshTodos(ctx);
  });

  pi.registerCommand("gui:scan-todo", {
    description: "打开 TODO 调度 GUI：选中、定位文件、补充说明后发送",
    handler: async (_args: string, ctx: any) => {
      if (!ctx.hasUI) return;
      // GUI 是用户主动启动的：强制扫描（~ 目录也不跳过），且不设超时
      await refreshTodos(ctx, { force: true, timeout: 0 });
      if (todoState.status !== "done") { ctx.ui.notify("TODO 扫描失败", "error"); return; }

      const todos = todoState.items;
      if (todos.length === 0) { ctx.ui.notify("没有 TODO", "info"); return; }

      // 启动 Wails GUI
      if (!findGuiBinary()) { ctx.ui.notify("未找到 wails-gui，请先构建", "error"); return; }

      const result = await runGuiWindow("routing", { todos, cwd: ctx.cwd }, { timeoutMs: 300_000 });

      if (!result.ok || result.data?.action === "cancel" || !result.data?.todos?.length) return;

      const itemsBlock = result.data.todos.map((item: { file: string; line: number; text: string }) =>
        `- \`${item.file}:${item.line}\`\n  > ${item.text}`).join("\n");
      let msg = `处理以下 TODO:\n\n${itemsBlock}`;
      if (result.data.note) msg += `\n\n补充: ${result.data.note}`;
      pi.sendUserMessage(msg);
      ctx.ui.notify(`已发送 ${result.data.todos.length} 个 TODO`, "info");
    },
  });

  pi.registerShortcut("ctrl+shift+t", {
    description: "刷新 TODO 列表",
    handler: async (ctx) => { if (ctx.hasUI) await refreshTodos(ctx); },
  });
}
