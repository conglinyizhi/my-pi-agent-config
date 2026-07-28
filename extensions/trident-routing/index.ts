// trident-routing — 主Agent（林汐）工具权限控制
//
// 航母不亲自出击。禁止主Agent使用 write/edit 工具，
// 强制她通过 translate_task / task_create / subagent 调度工作。
// 
// /homeport 指令可临时解除限制，用于开发调试。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTodos, visibleWidth, truncateToWidth, type TodoItem, type ScanState } from "./todo-scan";

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
  const MAX_DISPLAY = 15;
  let todoState: ScanState = { status: "idle" };

  function buildTodoWidget(state: ScanState) {
    return (_tui: unknown, theme: any) => ({
      render(width: number): string[] {
        if (state.status === "idle" || state.status === "scanning") {
          return [theme.fg("dim", `📋 TODO: ${state.status === "scanning" ? "扫描中…" : "就绪"}`)];
        }
        if (state.status === "timeout") return [theme.fg("error", "📋 TODO: 扫描超时")];
        if (state.status === "error") return [theme.fg("warning", `📋 TODO: ${state.message}`)];

        const { items, total, doneCount, expanded } = state;
        if (total === 0) return [theme.fg("success", "📋 TODO(s): 0/0 ✓")];
        if (doneCount === total) return [theme.fg("success", `📋 TODO(s): ${doneCount}/${total} ✓`)];

        const pending = items.filter((i) => !i.done);
        if (!expanded) {
          return [theme.fg("accent", `📋 TODO(s): ${doneCount}/${total}`) + theme.fg("dim", "  /scan-todo 展开")];
        }

        const showing = Math.min(pending.length, MAX_DISPLAY);
        const header = `📋 TODO(s): ${doneCount}/${total}${pending.length > MAX_DISPLAY ? `（显示前 ${showing} 项）` : ""}`;
        const lines: string[] = [theme.fg("accent", header)];
        for (const [idx, item] of pending.slice(0, MAX_DISPLAY).entries()) {
          const num = theme.fg("warning", String(idx + 1).padStart(2));
          const locText = truncateToWidth(`${item.file}:${item.line}`, Math.min(50, Math.floor(width * 0.3)));
          const locW = visibleWidth(locText);
          const loc = theme.fg("muted", locText);
          const content = theme.fg("dim", truncateToWidth(item.text, Math.max(20, width - 10 - locW)));
          lines.push(` ${num} ${loc}${theme.fg("dim", " │ ")}${content}`);
        }
        const done = items.filter((i) => i.done);
        if (done.length > 0) {
          const maxDone = 5;
          lines.push(theme.fg("dim", `  已完成 ${done.length} 项`));
          for (const item of done.slice(0, maxDone)) {
            lines.push(theme.fg("dim", `   ${truncateToWidth(`${item.file}:${item.line}`, 50)}  ${truncateToWidth(item.text, Math.max(10, width - 56))}`));
          }
        }
        return lines;
      },
      invalidate() {},
    });
  }

  async function refreshTodos(ctx: any) {
    todoState = { status: "scanning" };
    ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState));
    const result = await scanTodos(pi, ctx.cwd);
    if (result === null) { todoState = { status: "timeout" }; ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState)); return; }
    const prevExpanded = todoState.status === "done" ? todoState.expanded : false;
    todoState = { status: "done", ...result, expanded: prevExpanded };
    ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState));
    pi.events.emit("todo-scanner:result", { count: result.total, done: result.doneCount });
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) await refreshTodos(ctx);
  });

  pi.registerCommand("scan-todo", {
    description: "展开 TODO 列表，或选中指定 TODO 发送给 AI",
    handler: async (args, ctx: any) => {
      if (!ctx.hasUI) return;
      await refreshTodos(ctx);
      if (todoState.status !== "done") { ctx.ui.notify("TODO 扫描失败", "error"); return; }

      const trimmed = args.trim();
      if (!trimmed) {
        todoState.expanded = true;
        ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState));
        ctx.ui.notify(`TODO: ${todoState.doneCount}/${todoState.total}`, "info");
        return;
      }

      const pending = todoState.items.filter((i) => !i.done);
      const rawSet = new Set<number>();
      for (const part of trimmed.split(",")) {
        const seg = part.trim();
        const rm = seg.match(/^(\d+)-(\d+)$/);
        if (rm) { for (let i = +rm[1]!; i <= +rm[2]!; i++) rawSet.add(i); }
        else { const n = parseInt(seg, 10); if (!isNaN(n) && n >= 1) rawSet.add(n); }
      }
      const indices = [...rawSet].sort((a, b) => a - b);
      if (indices.length === 0 || indices[0]! > pending.length) { ctx.ui.notify("序号无效", "warning"); return; }

      const selected = indices.map((i) => pending[i - 1]!);
      const note = await ctx.ui.input(selected.length === 1 ? `补充信息 — ${selected[0]!.file}:${selected[0]!.line}` : `补充信息 — ${selected.length} 个 TODO`);
      const block = selected.map((item) => `- \`${item.file}:${item.line}\`\n  > ${item.text}`).join("\n");
      let msg = `处理以下 TODO:\n\n${block}`;
      if (note) msg += `\n\n补充: ${note}`;
      pi.sendUserMessage(msg);
      todoState.expanded = false;
      ctx.ui.setWidget(WIDGET_ID, buildTodoWidget(todoState));
      ctx.ui.notify(`已发送 ${indices.length} 个 TODO`, "info");
    },
  });

  pi.registerShortcut("ctrl+shift+t", {
    description: "刷新 TODO 列表",
    handler: async (ctx) => { if (ctx.hasUI) await refreshTodos(ctx); },
  });
}
