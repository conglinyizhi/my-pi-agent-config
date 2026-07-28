import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const QUEUE_DIR = path.join(os.homedir(), ".pi", "agent", "queue");
const ACTIVE_DIR = path.join(QUEUE_DIR, "active");
const DONE_DIR = path.join(QUEUE_DIR, "done");
const BLOCKED_DIR = path.join(QUEUE_DIR, "blocked");
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7天

export interface TaskItem {
  id: string;
  title: string;
  source: "chat" | "manual";
  status: "pending" | "planning" | "executing" | "reviewing" | "done" | "blocked";
  created_at: string;
  subtasks: string[];
  context: string;
}

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
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
  }
  return null;
}

function writeTask(task: TaskItem): void {
  ensureDirs();
  const p = taskPath(task.id, task.status);
  // 跨目录移动：删除旧位置
  for (const dir of [ACTIVE_DIR, BLOCKED_DIR, DONE_DIR]) {
    const old = path.join(dir, `${task.id}.json`);
    if (fs.existsSync(old) && old !== p) {
      fs.unlinkSync(old);
    }
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
      if (new Date(task.created_at).getTime() < cutoff) {
        fs.unlinkSync(p);
      }
    } catch {
      // 损坏文件直接删
      fs.unlinkSync(p);
    }
  }
}

export default function (pi: ExtensionAPI) {
  ensureDirs();

  // 启动时清理过期 done
  pi.on("session_start", () => {
    cleanupDone();
  });

  // --- task_create ---
  pi.registerTool({
    name: "task_create",
    label: "Create Task",
    description: "创建一个新事项。id 使用 kebab-case。",
    promptSnippet: "Create a new task in the task queue",
    promptGuidelines: [
      "Use task_create to save a task after translate_task produces a structured description. Generate a kebab-case id from the title.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "唯一标识，kebab-case" }),
      title: Type.String({ description: "任务标题" }),
      context: Type.String({ description: "任务上下文和详情" }),
      source: Type.Optional(Type.String({ description: "chat 或 manual，默认 chat" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const existing = readTask(params.id);
      if (existing) {
        return {
          content: [{ type: "text", text: `事项 ${params.id} 已存在。使用 task_update 修改。` }],
          details: { error: "duplicate", existing },
        };
      }

      const task: TaskItem = {
        id: params.id,
        title: params.title,
        source: (params.source as "chat" | "manual") || "chat",
        status: "pending",
        created_at: new Date().toISOString(),
        subtasks: [],
        context: params.context,
      };

      writeTask(task);

      return {
        content: [{ type: "text", text: `事项已创建：${task.title}（${task.id}）` }],
        details: { task },
      };
    },
  });

  // --- task_list ---
  pi.registerTool({
    name: "task_list",
    label: "List Tasks",
    description: "列出当前活跃的事项。可选过滤状态。",
    promptSnippet: "List active tasks",
    promptGuidelines: [
      "Use task_list to show the user their current tasks. Filter by status if needed (active, blocked, done).",
    ],
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "过滤：active（默认）、blocked、done、all" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const filter = !params.status || params.status === "active" ? undefined : params.status;
      const tasks = listTasks(filter);

      if (tasks.length === 0) {
        return {
          content: [{ type: "text", text: "当前没有事项。" }],
          details: { tasks: [] },
        };
      }

      const lines = tasks.map((t) =>
        `- **${t.id}** [${t.status}] ${t.title}（${new Date(t.created_at).toLocaleString("zh-CN")}）`
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { tasks },
      };
    },
  });

  // --- task_update ---
  pi.registerTool({
    name: "task_update",
    label: "Update Task",
    description: "更新事项状态或添加上下文。",
    promptSnippet: "Update a task's status or details",
    promptGuidelines: [
      "Use task_update to change a task's status (pending→planning→executing→reviewing→done) or to append context.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "事项标识" }),
      status: Type.Optional(Type.String({
        description: "新状态：pending、planning、executing、reviewing、done、blocked",
      })),
      append_context: Type.Optional(Type.String({ description: "追加到 context 字段" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = readTask(params.id);
      if (!task) {
        return {
          content: [{ type: "text", text: `事项 ${params.id} 不存在。` }],
          details: { error: "not_found" },
        };
      }

      if (params.status) {
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

  // --- task_delete ---
  pi.registerTool({
    name: "task_delete",
    label: "Delete Task",
    description: "删除一个事项（移到 done 或直接删除）。",
    parameters: Type.Object({
      id: Type.String({ description: "事项标识" }),
      permanent: Type.Optional(Type.Boolean({ description: "永久删除，不移动到 done" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = readTask(params.id);
      if (!task) {
        return {
          content: [{ type: "text", text: `事项 ${params.id} 不存在。` }],
          details: { error: "not_found" },
        };
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

  // --- status widget ---
  pi.on("session_start", (_event, ctx) => {
    const updateWidget = () => {
      const tasks = listTasks();
      if (tasks.length === 0) {
        ctx.ui.setWidget("trident-queue", undefined);
        return;
      }

      const lines: string[] = [`⚓ 舰队事项（${tasks.length}）`];
      for (const t of tasks) {
        const icon = t.status === "executing" ? "▶" :
          t.status === "blocked" ? "⏸" :
          t.status === "planning" ? "📋" :
          t.status === "reviewing" ? "🔍" : "○";
        const shortTitle = t.title.length > 40 ? t.title.slice(0, 37) + "..." : t.title;
        lines.push(`${icon} ${shortTitle}`);
      }
      ctx.ui.setWidget("trident-queue", lines);
    };

    updateWidget();
    // 每次 agent 结束后刷新
    pi.on("agent_settled", () => updateWidget());
  });
}
