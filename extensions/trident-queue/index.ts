// trident-queue — 事项队列 + task_new 全链路工具
//
// task_new：翻译 → GUI 确认 → 创建 → subagent 执行 → 自动回写状态
// 状态机：pending → executing → done（失败→blocked）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, execSync } from "node:child_process";
import { visibleWidth, truncateToWidth } from "../trident-routing/todo-scan";
import { getTranslatorModel, callPiTranslate, TRANSLATOR_SYSTEM_PROMPT, looksStructured } from "../../lib/translate";
import { runSubagent, getResultOutput, isFailedResult, formatUsageStats, getWorkerModel } from "../../lib/subagent-run";
import type { SubagentResult } from "../../lib/subagent-run";

const QUEUE_DIR = path.join(os.homedir(), ".pi", "agent", "queue");
const ACTIVE_DIR = path.join(QUEUE_DIR, "active");
const DONE_DIR = path.join(QUEUE_DIR, "done");
const BLOCKED_DIR = path.join(QUEUE_DIR, "blocked");
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface TaskItem {
  id: string;
  title: string;
  source: "chat" | "manual";
  status: "pending" | "executing" | "done" | "blocked";
  created_at: string;
  session: string;
  subtasks: string[];
  context: string;
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["executing"],
  executing: ["done", "blocked"],
  done: [],
  blocked: ["pending", "executing"],
};

// ═══════════════════════════════════
// 文件操作
// ═══════════════════════════════════

function ensureDirs(): void {
  for (const dir of [ACTIVE_DIR, DONE_DIR, BLOCKED_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function taskPath(id: string, status?: string): string {
  if (status === "done") return path.join(DONE_DIR, `${id}.json`);
  if (status === "blocked") return path.join(BLOCKED_DIR, `${id}.json`);
  return path.join(ACTIVE_DIR, `${id}.json`);
}

function readTask(id: string): TaskItem | null {
  for (const dir of [ACTIVE_DIR, BLOCKED_DIR, DONE_DIR]) {
    const p = path.join(dir, `${id}.json`);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  }
  return null;
}

function writeTask(task: TaskItem): void {
  ensureDirs();
  const p = taskPath(task.id, task.status);
  for (const dir of [ACTIVE_DIR, BLOCKED_DIR, DONE_DIR]) {
    const old = path.join(dir, `${task.id}.json`);
    if (fs.existsSync(old) && old !== p) fs.unlinkSync(old);
  }
  fs.writeFileSync(p, JSON.stringify(task, null, 2), "utf-8");
}

function listTasks(statusFilter?: string): TaskItem[] {
  ensureDirs();
  const tasks: TaskItem[] = [];
  const dirs = statusFilter
    ? [statusFilter === "done" ? DONE_DIR : statusFilter === "blocked" ? BLOCKED_DIR : ACTIVE_DIR]
    : [ACTIVE_DIR, BLOCKED_DIR];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      tasks.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
    }
  }
  return tasks.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function cleanupDone(): void {
  if (!fs.existsSync(DONE_DIR)) return;
  const cutoff = Date.now() - DONE_RETENTION_MS;
  for (const f of fs.readdirSync(DONE_DIR)) {
    if (!f.endsWith(".json")) continue;
    const p = path.join(DONE_DIR, f);
    try {
      const task = JSON.parse(fs.readFileSync(p, "utf-8")) as TaskItem;
      if (new Date(task.created_at).getTime() < cutoff) fs.unlinkSync(p);
    } catch {
      fs.unlinkSync(p);
    }
  }
}

function generateId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

// ═══════════════════════════════════
// GUI 确认（Electron）
// ═══════════════════════════════════

function findElectron(): string | null {
  try {
    const bins = execSync("ls /usr/bin/electron* 2>/dev/null", { encoding: "utf-8" })
      .trim().split("\n").filter(Boolean).sort().reverse();
    return bins[0] || null;
  } catch {
    return null;
  }
}

async function showTaskReviewGui(
  texts: string[],
  signal: AbortSignal | undefined,
): Promise<{ action: string; texts?: string[]; feedbacks?: Array<{ index: number; comment: string }> } | "gui-unavailable"> {
  const electronBin = findElectron();
  if (!electronBin) return "gui-unavailable";

  const appJs = path.join(os.homedir(), ".pi", "agent", "extensions", "trident-queue", "gui-review", "app.js");
  if (!fs.existsSync(appJs)) return "gui-unavailable";

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-"));
  const requestFile = path.join(tmpDir, "request.json");
  const responseFile = path.join(tmpDir, "response.json");

  fs.writeFileSync(requestFile, JSON.stringify({ texts }));

  try {
    const proc = spawn(electronBin, [appJs, requestFile, responseFile], {
      stdio: "ignore",
      detached: true,
    });

    const GUI_TIMEOUT = 120_000;
    const result = await new Promise<any>((resolve) => {
      const timeout = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch {}
        resolve({ action: "cancelled" });
      }, GUI_TIMEOUT);

      const check = setInterval(() => {
        try {
          const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
          clearTimeout(timeout);
          clearInterval(check);
          resolve(data);
        } catch {}
      }, 300);

      proc.on("close", () => {
        setTimeout(() => {
          try {
            const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
            clearTimeout(timeout);
            clearInterval(check);
            resolve(data);
          } catch {
            clearTimeout(timeout);
            clearInterval(check);
            resolve({ action: "cancelled" });
          }
        }, 100);
      });

      if (signal) {
        const onAbort = () => {
          clearTimeout(timeout);
          clearInterval(check);
          try { proc.kill("SIGTERM"); } catch {}
          resolve("gui-unavailable");
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    return result;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

// ═══════════════════════════════════

// 跟踪正在运行的子进程 PID，供 /task-manager 紧急终止
const runningPids = new Map<string, number>();

export default function (pi: ExtensionAPI) {
  ensureDirs();

  pi.on("session_start", () => {
    cleanupDone();
  });

  // ═══════════════════════════
  // task_new — 唯一入口
  // ═══════════════════════════
  // task_create — 唯一入口（支持单任务/并行多任务）
  // ═══════════════════════════

  pi.registerTool({
    name: "task_create",
    label: "Create Task (Dispatch)",
    description:
      "将用户发言转为结构化任务并自动执行。支持单个字符串（单任务）或字符串数组（并行多任务）。",
    promptSnippet: "Create and dispatch task(s) from user utterance(s)",
    promptGuidelines: [
      "当用户说「帮我做X」时，调 task_create({ utterance: '用户原话' })。",
      "当用户同时提出多个独立任务时，调 task_create({ utterance: ['任务A原话', '任务B原话'] })，系统会并行执行。",
      "如果返回 action='feedback'，说明用户对某些任务提了修改意见，根据 feedbacks 调整后再次调用。",
    ],
    parameters: Type.Object({
      utterance: Type.Union([
        Type.String({ description: "单个用户的原始发言" }),
        Type.Array(Type.String(), { description: "多个用户的原始发言，并行执行" }),
      ]),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const raw = params.utterance;
      const utterances: string[] = Array.isArray(raw) ? raw : [raw];

      // 1. 并行翻译
      const translatorModel = getTranslatorModel();
      if (!translatorModel) {
        return {
          content: [{ type: "text", text: "错误：未配置 translator 模型。" }],
          details: { error: "no_translator_model" },
        };
      }

      const translateResults = await Promise.all(
        utterances.map(async (u) => {
          try {
            const { text, stderr, exitCode } = await callPiTranslate(
              translatorModel, TRANSLATOR_SYSTEM_PROMPT, u, signal,
            );
            if (exitCode !== 0 || !text || !looksStructured(text)) {
              return { error: `翻译失败`, raw: text || "", stderr };
            }
            return { text };
          } catch (err) {
            return { error: String(err) };
          }
        }),
      );

      const failed = translateResults.filter((r) => r.error);
      if (failed.length > 0) {
        return {
          content: [{ type: "text", text: `${failed.length}/${utterances.length} 个翻译失败：${failed.map((f) => f.error).join("；")}` }],
          details: { failed },
        };
      }

      const translatedTexts = translateResults.map((r) => r.text!);

      // 2. GUI 确认
      let finalTexts = translatedTexts;
      if (ctx.hasUI) {
        const guiResult = await showTaskReviewGui(finalTexts, signal);
        if (guiResult === "gui-unavailable") {
          // 跳过确认
        } else if (guiResult.action === "cancelled") {
          return { content: [{ type: "text", text: "已取消。" }], details: { action: "cancelled" } };
        } else if (guiResult.action === "approve") {
          finalTexts = guiResult.texts || finalTexts;
          if (guiResult.feedbacks?.length) {
            const fbDesc = guiResult.feedbacks.map((f) => `[${f.index}] ${f.comment}`).join("；");
            return {
              content: [{ type: "text", text: `部分任务被退回重译：${fbDesc}` }],
              details: { action: "feedback", feedbacks: guiResult.feedbacks },
            };
          }
        }
      }

      // 3. 并行创建 + 执行
      const workerModel = getWorkerModel();
      const sessionFile = ctx.sessionManager?.getSessionFile?.() || "unknown";

      const results = await Promise.all(
        finalTexts.map(async (finalText, i) => {
          const title = finalText.match(/\*\*title\*\*:\s*(.+)/i)?.[1]?.trim() || `任务 ${i + 1}`;
          const goal = finalText.match(/\*\*goal\*\*:\s*(.+)/i)?.[1]?.trim() || finalText.slice(0, 100);
          const id = generateId(title) || `task-${Date.now().toString(36)}-${i}`;

          const task: TaskItem = {
            id, title, source: "chat", status: "executing",
            created_at: new Date().toISOString(),
            session: path.basename(sessionFile),
            subtasks: [],
            context: `**goal**: ${goal}\n\n${finalText}`,
          };

          if (readTask(id)) {
            return { id, title, error: "duplicate" };
          }

          writeTask(task);
          const subagentPrompt = `任务目标：${goal}\n\n完整描述：\n${finalText}`;

          try {
            const subagentResult = await runSubagent({
              task: subagentPrompt, cwd: ctx.cwd, model: workerModel,
              signal, taskId: id,
              onSpawn: (pid) => { runningPids.set(id, pid); },
            });
            runningPids.delete(id);

            const output = getResultOutput(subagentResult);
            const usage = formatUsageStats(subagentResult.usage, subagentResult.model);

            if (isFailedResult(subagentResult)) {
              task.status = "blocked";
              task.context += `\n---\n执行失败（exit=${subagentResult.exitCode}）：\n${output}`;
              writeTask(task);
              return { id, title, status: "blocked", output, usage };
            }

            task.status = "done";
            task.context += `\n---\n执行完成：\n${output}`;
            writeTask(task);
            return { id, title, status: "done", output, usage };
          } catch (err) {
            runningPids.delete(id);
            task.status = "blocked";
            task.context += `\n---\n执行异常：${String(err)}`;
            writeTask(task);
            return { id, title, status: "blocked", error: String(err) };
          }
        }),
      );

      // 4. 汇总结果
      const doneCount = results.filter((r) => r.status === "done").length;
      const blockedCount = results.filter((r) => r.status === "blocked").length;
      const lines = results.map((r) => {
        const icon = r.status === "done" ? "✅" : r.status === "blocked" ? "❌" : "⚠️";
        return `${icon} [${r.id}] ${r.title}${r.usage ? ` ${r.usage}` : ""}`;
      });

      return {
        content: [{
          type: "text",
          text: `完成 ${doneCount}/${results.length} 个任务${blockedCount > 0 ? `（${blockedCount} 失败）` : ""}\n\n${lines.join("\n")}`,
        }],
        details: { results },
      };
    },
  });

  // ═══════════════════════════
  // task_list
  // ═══════════════════════════

  pi.registerTool({
    name: "task_list",
    label: "List Tasks",
    description: "列出当前活跃的事项。可选过滤状态。",
    promptSnippet: "List active tasks",
    promptGuidelines: [
      "Use task_list to show the user their current tasks.",
    ],
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "过滤：active（默认）、blocked、done、all" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const filter = !params.status || params.status === "active" ? undefined : params.status;
      const tasks = listTasks(filter);

      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "当前没有事项。" }], details: { tasks: [] } };
      }

      const statusIcon: Record<string, string> = {
        pending: "○",
        executing: "▶",
        done: "✓",
        blocked: "⏸",
      };

      const lines = tasks.map((t) =>
        `- **${t.id}** ${statusIcon[t.status] || "○"} ${t.title}（${new Date(t.created_at).toLocaleString("zh-CN")}）`
      );

      return { content: [{ type: "text", text: lines.join("\n") }], details: { tasks } };
    },
  });

  // ═══════════════════════════
  // task_update
  // ═══════════════════════════

  pi.registerTool({
    name: "task_update",
    label: "Update Task",
    description: "更新事项状态或添加上下文。",
    promptSnippet: "Update a task's status or details",
    promptGuidelines: [
      "Use task_update to change a task's status or append context.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "事项标识" }),
      status: Type.Optional(Type.String({ description: "新状态：pending、executing、done、blocked" })),
      append_context: Type.Optional(Type.String({ description: "追加到 context 字段" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = readTask(params.id);
      if (!task) {
        return { content: [{ type: "text", text: `事项 ${params.id} 不存在。` }], details: { error: "not_found" } };
      }

      if (params.status) {
        const allowed = VALID_TRANSITIONS[task.status] || [];
        if (!allowed.includes(params.status)) {
          return {
            content: [{
              type: "text",
              text: `不允许从 ${task.status} 转到 ${params.status}。允许：${allowed.join(", ") || "（终态）"}`,
            }],
            details: { error: "invalid_transition", current: task.status, requested: params.status, allowed },
          };
        }
        task.status = params.status as TaskItem["status"];
      }
      if (params.append_context) {
        task.context += `\n---\n${params.append_context}`;
      }

      writeTask(task);
      return {
        content: [{ type: "text", text: `事项已更新：${task.title} → ${task.status}` }],
        details: { task },
      };
    },
  });

  // ═══════════════════════════
  // task_delete
  // ═══════════════════════════

  pi.registerTool({
    name: "task_delete",
    label: "Delete Task",
    description: "删除一个事项（移到 done 或永久删除）。",
    parameters: Type.Object({
      id: Type.String({ description: "事项标识" }),
      permanent: Type.Optional(Type.Boolean({ description: "永久删除，不移动到 done" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = readTask(params.id);
      if (!task) {
        return { content: [{ type: "text", text: `事项 ${params.id} 不存在。` }], details: { error: "not_found" } };
      }

      if (params.permanent) {
        const p = taskPath(task.id, task.status);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } else {
        task.status = "done";
        writeTask(task);
      }

      return {
        content: [{ type: "text", text: `事项已${params.permanent ? "永久删除" : "归档"}：${task.title}` }],
        details: {},
      };
    },
  });

  // ═══════════════════════════
  // /task-manager GUI
  // ═══════════════════════════

  pi.registerCommand("task-manager", {
    description: "GUI：查看任务详情、紧急关停运行中的任务",
    handler: async (_args, ctx) => {
      const electronBin = findElectron();
      if (!electronBin) {
        ctx.ui.notify("未找到 electron。请安装：yay -S electron", "error");
        return;
      }

      const appJs = path.join(os.homedir(), ".pi", "agent", "extensions", "trident-queue", "gui-manager", "app.js");
      if (!fs.existsSync(appJs)) {
        ctx.ui.notify("GUI 未构建。执行 pnpm build:gui-manager", "error");
        return;
      }

      const tasks = listTasks();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-"));
      const requestFile = path.join(tmpDir, "request.json");
      const responseFile = path.join(tmpDir, "response.json");

      fs.writeFileSync(requestFile, JSON.stringify({ tasks }));

      try {
        const proc = spawn(electronBin, [appJs, requestFile, responseFile], {
          stdio: "ignore",
          detached: true,
        });

        const GUI_TIMEOUT = 300_000;
        const result = await new Promise<any>((resolve) => {
          const timeout = setTimeout(() => {
            try { proc.kill("SIGTERM"); } catch {}
            resolve({ cancelled: true });
          }, GUI_TIMEOUT);

          const check = setInterval(() => {
            try {
              const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
              clearTimeout(timeout);
              clearInterval(check);
              resolve(data);
            } catch {}
          }, 300);

          proc.on("close", () => {
            setTimeout(() => {
              try {
                const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
                clearTimeout(timeout);
                clearInterval(check);
                resolve(data);
              } catch {
                clearTimeout(timeout);
                clearInterval(check);
                resolve({ cancelled: true });
              }
            }, 100);
          });
        });

        if (result?.action === "kill" && result.taskId) {
          const pid = runningPids.get(result.taskId);
          if (pid) {
            try { process.kill(pid, "SIGTERM"); } catch {}
            runningPids.delete(result.taskId);
          }
          const task = readTask(result.taskId);
          if (task && task.status === "executing") {
            task.status = "blocked";
            task.context += `\n---\n用户手动终止`;
            writeTask(task);
          }
          ctx.ui.notify(`已终止：${result.taskId}`, "warning");
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
      }
    },
  });

  // ═══════════════════════════
  // Widget
  // ═══════════════════════════

  let todoData: { count: number; done: number } | null = null;

  pi.on("session_start", (_event, ctx) => {
    pi.events.on("todo-scanner:result", (data: any) => {
      if (data) {
        todoData = { count: data.count, done: data.done ?? 0 };
        refreshWidget();
      }
    });

    const refreshWidget = () => {
      const allTasks = listTasks();
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      const sessionName = sessionFile ? path.basename(sessionFile) : "";
      const tasks = sessionName
        ? allTasks.filter((t) => !t.session || t.session === "unknown" || t.session === sessionName)
        : allTasks;

      const tc = todoData?.count ?? null;
      if (tasks.length === 0 && (tc === null || tc === 0)) {
        ctx.ui.setWidget("trident-queue", undefined);
        return;
      }

      const todoLabel = tc === null ? "…" : `${todoData!.done}/${tc}`;
      const headerLine = `⚓ 舰队事项(${tasks.length}) | 📋备战事项(${todoLabel})`;
      const hintLine = tc !== null && tc > 0
        ? `<还有${tc - (todoData!.done ?? 0)}个todo待处理>  /scan-todo 展开` : null;

      ctx.ui.setWidget("trident-queue", (_tui: any, theme: any) => ({
        render: (_width: number) => {
          const lines: string[] = [theme.fg("accent", headerLine)];
          if (hintLine) lines.push(theme.fg("dim", hintLine));
          for (const t of tasks) {
            const icon = t.status === "executing" ? "▶" :
              t.status === "blocked" ? "⏸" :
              t.status === "done" ? "✓" : "○";
            const maxTitleW = Math.max(10, _width - 3);
            const shortTitle = truncateToWidth(t.title, maxTitleW);
            lines.push(`${icon} ${shortTitle}`);
          }
          return lines;
        },
      }));
    };

    refreshWidget();
    pi.on("agent_settled", () => refreshWidget());
  });

  // ═══════════════════════════
  // /trident-models
  // ═══════════════════════════

  pi.registerCommand("trident-models", {
    description: "查看/切换三叉戟模型路由配置",
    handler: async (args, ctx) => {
      const rolesPath = path.join(os.homedir(), ".pi", "agent", "providers.roles.toml");
      if (!fs.existsSync(rolesPath)) {
        ctx.ui.notify("providers.roles.toml 不存在。", "warning");
        return;
      }

      const content = fs.readFileSync(rolesPath, "utf-8");
      const roles = parseRolesToml(content);

      if (args) {
        const parts = args.trim().split(/\s+/);
        if (parts.length >= 2) {
          const [role, model] = [parts[0], parts.slice(1).join(" ")];
          if (roles[role] !== undefined) {
            const newContent = content.replace(
              new RegExp(`^${role}\\s*=\\s*.*$`, "m"),
              `${role} = "${model}"`,
            );
            fs.writeFileSync(rolesPath, newContent, "utf-8");
            ctx.ui.notify(`${role} → ${model}`, "info");
          } else {
            ctx.ui.notify(`未知角色：${role}。可用：${Object.keys(roles).join(", ")}`, "error");
          }
        }
        return;
      }

      const lines = ["当前模型路由："];
      for (const [role, model] of Object.entries(roles)) {
        lines.push(`  ${role} → ${model}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ═══════════════════════════
  // /trident-setup
  // ═══════════════════════════

  pi.registerCommand("trident-setup", {
    description: "GUI：选择模型配置三叉戟路由",
    handler: async (_args, ctx) => {
      const electronBin = findElectron();
      if (!electronBin) {
        ctx.ui.notify("未找到 electron。请安装：yay -S electron", "error");
        return;
      }

      const rolesPath = path.join(os.homedir(), ".pi", "agent", "providers.roles.toml");
      const examplePath = path.join(os.homedir(), ".pi", "agent", "providers.roles.example.toml");

      const allModels = ctx.modelRegistry.getAll();
      if (allModels.length === 0) {
        ctx.ui.notify("未找到可用模型。请先配置 providers。", "error");
        return;
      }

      const models = allModels.map((m) => ({
        value: `${m.provider}/${m.id}`,
        name: m.name || m.id,
      }));

      let roles: Record<string, string> = {};
      try {
        if (fs.existsSync(rolesPath)) {
          roles = parseRolesToml(fs.readFileSync(rolesPath, "utf-8"));
        } else if (fs.existsSync(examplePath)) {
          roles = parseRolesToml(fs.readFileSync(examplePath, "utf-8"));
        }
      } catch {}

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trident-setup-"));
      const requestFile = path.join(tmpDir, "request.json");
      const responseFile = path.join(tmpDir, "response.json");
      const appJs = path.join(os.homedir(), ".pi", "agent", "extensions", "trident-queue", "gui", "app.js");

      if (!fs.existsSync(appJs)) {
        fs.rmSync(tmpDir, { recursive: true });
        ctx.ui.notify("GUI app.js 未找到", "error");
        return;
      }

      fs.writeFileSync(requestFile, JSON.stringify({ models, roles }));
      ctx.ui.notify("正在启动模型选择器...", "info");

      try {
        const proc = spawn(electronBin, [appJs, requestFile, responseFile], {
          stdio: "ignore",
          detached: true,
        });

        const GUI_TIMEOUT = 120_000;
        const result = await new Promise<any>((resolve) => {
          const timeout = setTimeout(() => {
            try { proc.kill("SIGTERM"); } catch {}
            resolve({ cancelled: true });
          }, GUI_TIMEOUT);

          const check = setInterval(() => {
            try {
              const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
              clearTimeout(timeout);
              clearInterval(check);
              resolve(data);
            } catch {}
          }, 300);

          proc.on("close", () => {
            setTimeout(() => {
              try {
                const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
                clearTimeout(timeout);
                clearInterval(check);
                resolve(data);
              } catch {
                clearTimeout(timeout);
                clearInterval(check);
                resolve({ cancelled: true });
              }
            }, 100);
          });
        });

        if (result.cancelled) {
          ctx.ui.notify("已取消。", "warning");
          return;
        }

        if (!result.roles) {
          ctx.ui.notify("无效的响应。", "error");
          return;
        }

        let toml = "# 三叉戟模型路由配置\n# 由 /trident-setup 生成\n\n[roles]\n";
        for (const role of ["oc", "translator", "worker"]) {
          if (result.roles[role]) {
            toml += `${role} = "${result.roles[role]}"\n`;
          }
        }

        try {
          if (fs.existsSync(rolesPath)) {
            const original = fs.readFileSync(rolesPath, "utf-8");
            const workersMatch = original.match(/\[workers\.\w+\][\s\S]*/);
            if (workersMatch) toml += "\n" + workersMatch[0];
          }
        } catch {}

        fs.writeFileSync(rolesPath, toml, "utf-8");
        ctx.ui.notify("配置已保存到 providers.roles.toml，/reload 生效", "info");
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
      }
    },
  });
}

function parseRolesToml(content: string): Record<string, string> {
  const roles: Record<string, string> = {};
  let inRoles = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "[roles]") { inRoles = true; continue; }
    if (inRoles && trimmed.startsWith("[")) break;
    if (!inRoles) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && value) roles[key] = value;
  }
  return roles;
}
