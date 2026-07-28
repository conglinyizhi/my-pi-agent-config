// GUI 构建参考：skill gui-standards（GUI 骨架 + Vue + rsbuild + esbuild 模式）
//
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, execSync } from "node:child_process";
import { visibleWidth, truncateToWidth } from "../trident-routing/todo-scan";

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
  session: string;
  subtasks: string[];
  context: string;
}

// 状态流转表：每个状态只能转到指定状态
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["planning"],
  planning: ["executing", "blocked"],
  executing: ["reviewing", "blocked"],
  reviewing: ["done", "blocked"],
  done: [],
  blocked: ["pending", "executing"],
};

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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const existing = readTask(params.id);
      if (existing) {
        return {
          content: [{ type: "text", text: `事项 ${params.id} 已存在。使用 task_update 修改。` }],
          details: { error: "duplicate", existing },
        };
      }

      const sessionFile = ctx.sessionManager?.getSessionFile?.() || "unknown";

      const task: TaskItem = {
        id: params.id,
        title: params.title,
        source: (params.source as "chat" | "manual") || "chat",
        status: "pending",
        created_at: new Date().toISOString(),
        session: path.basename(sessionFile),
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
        const allowed = VALID_TRANSITIONS[task.status] || [];
        if (!allowed.includes(params.status)) {
          return {
            content: [{
              type: "text",
              text: `不允许从 ${task.status} 直接转到 ${params.status}。允许的流转：${allowed.join(", ") || "（终态，不可变更）"}`,
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
  let todoData: { count: number; done: number } | null = null;

  pi.on("session_start", (_event, ctx) => {
    // 监听 todo-scanner 的扫描结果
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
              t.status === "planning" ? "📋" :
              t.status === "reviewing" ? "🔍" : "○";
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

  // --- /trident-models 命令 ---
  pi.registerCommand("trident-models", {
    description: "查看/切换三叉戟模型路由配置",
    handler: async (args, ctx) => {
      const rolesPath = path.join(os.homedir(), ".pi", "agent", "providers.roles.toml");
      if (!fs.existsSync(rolesPath)) {
        ctx.ui.notify("providers.roles.toml 不存在。从 providers.roles.example.toml 复制一份并填入模型。", "warning");
        return;
      }

      const content = fs.readFileSync(rolesPath, "utf-8");
      const roles = parseRolesToml(content);

      if (args) {
        // 切换模式：/trident-models worker openrouter:deepseek/deepseek-chat
        const parts = args.trim().split(/\s+/);
        if (parts.length >= 2) {
          const [role, model] = [parts[0], parts.slice(1).join(" ")];
          if (roles[role] !== undefined) {
            const escaped = model.includes('"') ? model : model;
            const newContent = content.replace(
              new RegExp(`^${role}\\s*=\\s*.*$`, "m"),
              `${role} = "${escaped}"`
            );
            fs.writeFileSync(rolesPath, newContent, "utf-8");
            ctx.ui.notify(`${role} → ${model}`, "info");
          } else {
            ctx.ui.notify(`未知角色：${role}。可用：${Object.keys(roles).join(", ")}`, "error");
          }
        }
        return;
      }

      // 查看模式
      const lines = ["当前模型路由："];
      for (const [role, model] of Object.entries(roles)) {
        lines.push(`  ${role} → ${model}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // --- /trident-setup 向导（Electron GUI） ---
  pi.registerCommand("trident-setup", {
    description: "GUI：选择模型配置三叉戟路由",
    handler: async (_args, ctx) => {
      // 查找 electron 二进制
      let electronBin: string | null = null;
      try {
        const bins = execSync("ls /usr/bin/electron* 2>/dev/null", { encoding: "utf-8" })
          .trim().split("\n").filter(Boolean).sort().reverse();
        electronBin = bins[0] || null;
      } catch {}

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
