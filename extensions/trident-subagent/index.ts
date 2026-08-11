// trident-subagent — 同步 subagent 派发 + 反馈模式开关 + 模型路由配置
//
// subagent({ task: string | string[] })：主 agent 整理好完整任务说明后调用，
// 同步等待全部 worker 返航（success/failed/aborted/timeout 逐项汇报）。
// /subagent:feedback on|off|toggle：后续新启动 worker 只允许 read/bash/be-* 工具。
// /gui:subagents：异步启动实时监视窗口（Wails 窗口轮询状态文件，不阻塞命令）。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runGuiWindow, launchGuiWindow, findGuiBinary } from "../../lib/gui-runner.ts";
import { getWorkerModel } from "../../lib/subagent-run.ts";
import { readFeedbackState, writeFeedbackState, buildToolsFromNames } from "./feedback.ts";
import { runBatch, type BatchItemResult } from "./batch.ts";
import { beginBatch, flushStatusFile, getSnapshot, type WorkerRun } from "./status.ts";

const BE_ERROR_RECORDER = path.join(os.homedir(), ".pi", "agent", "extensions", "be-error-recorder", "index.ts");
const ROLES_PATH = path.join(os.homedir(), ".pi", "agent", "providers.roles.toml");

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

export default function (pi: ExtensionAPI) {
  // 子进程内不注册派发工具，防递归
  if (process.env.PI_SUBAGENT) return;

  // ═══════════════════════════
  // subagent — 唯一派发入口（同步并发）
  // ═══════════════════════════

  pi.registerTool({
    name: "subagent",
    label: "Dispatch Subagent",
    description:
      "将已经由主 agent 整理好的完整任务说明派给一个或多个隔离 worker 子进程执行。同步等待：所有 worker 都进入终态（成功/失败/中止/超时）才返回。支持单个字符串（单 worker）或字符串数组（并行多 worker）。",
    promptSnippet: "Dispatch side-quests to worker subagents and wait for all results",
    promptGuidelines: [
      "subagent 是支线任务执行系统。参数必须是林汐自己整理好的完整任务说明（含目标、约束、验收标准），不是用户原始发言。",
      "判断标准：多步操作、涉及多个文件、需要独立上下文 → subagent；否则林汐自己动手。",
      "需要并行多个独立任务时传数组，全部并行启动。",
      "工具会同步阻塞直到所有 worker 结束：一个失败不终止其他 worker，逐个在结果里汇报。",
      "运行期间可用 /gui:subagents 查看每个 worker 的实时详情。",
      "反馈模式开启时 worker 只能用 read/bash/be-* 工具（/subagent:feedback 查看状态）。",
      "失败项若带 investigation 路径：先 read 该文件的「读档指引」与「最终结论」，以磁盘现状为准，勿假设 worker 无副作用；勿整文件灌回上下文。",
    ],
    parameters: Type.Object({
      task: Type.Union([
        Type.String({ description: "单个完整任务说明" }),
        Type.Array(Type.String(), { description: "多个完整任务说明，并行执行" }),
      ]),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const tasks: string[] = Array.isArray(params.task) ? params.task : [params.task];
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "错误：任务列表为空。" }], details: { error: "empty_batch" } };
      }

      const workerModel = getWorkerModel();
      const feedbackOn = readFeedbackState();
      const toolCfg = feedbackOn ? buildToolsFromNames(pi.getActiveTools()) : {};

      const runs: WorkerRun[] = tasks.map((task, i) => ({
        id: `w${i + 1}`,
        task,
        model: workerModel,
        status: "starting",
        startedAt: new Date().toISOString(),
      }));
      beginBatch(runs);

      const batchTaskId = `batch-${Date.now().toString(36)}`;
      onUpdate?.({
        content: [{
          type: "text",
          text: `已启动 ${tasks.length} 个 subagent，主线等待全部完成；/gui:subagents 查看实时详情${feedbackOn ? "（反馈模式）" : ""}`,
        }],
        details: { phase: "running" },
      });

      let results: BatchItemResult[];
      try {
        results = await runBatch(tasks, {
          cwd: ctx.cwd,
          model: workerModel,
          signal,
          tools: toolCfg.tools,
          extraExtensions: feedbackOn ? [BE_ERROR_RECORDER] : undefined,
          taskId: batchTaskId,
        });
      } finally {
        // 挂起合并写显式落盘（终态已立即写，此处兜底，确保进程结束前不丢状态）
        flushStatusFile();
      }

      const lines = results.map((r) => {
        const head = `#${r.index + 1} ${r.status.toUpperCase()}`;
        const meta = r.exitCode !== undefined ? ` exit=${r.exitCode}` : "";
        const err = r.errorMessage ? ` error=${r.errorMessage.slice(0, 300)}` : "";
        const stderr = r.stderr.trim() ? `\n  stderr: ${r.stderr.trim().slice(0, 500)}` : "";
        // inlineSummary 通常已含 investigation 路径；未含才补，避免重复
        const inv = r.investigationPath && !r.output.includes(r.investigationPath)
          ? `\n  investigation: ${r.investigationPath}\n  读档：先看该文件「读档指引」与「最终结论」`
          : "";
        return `${head}${meta}${err}${stderr}${inv}\n  ${r.output.slice(0, 800)}`;
      });

      const failedCount = results.filter((r) => r.status !== "success").length;
      onUpdate?.({
        content: [{
          type: "text",
          text: `${tasks.length} 个 subagent 已全部返航（成功 ${tasks.length - failedCount} / 失败 ${failedCount}）`,
        }],
        details: { phase: "done", results },
      });

      return {
        content: [{
          type: "text",
          text: `subagent 全部返航（${tasks.length - failedCount}/${tasks.length} 成功）：\n\n${lines.join("\n\n")}`,
        }],
        details: { results },
      };
    },
  });

  // ═══════════════════════════
  // /subagent:feedback — 反馈模式开关
  // ═══════════════════════════

  pi.registerCommand("subagent:feedback", {
    description: "切换 subagent 反馈模式：on|off|toggle（仅影响新启动的 worker，只允许 read/bash/be-* 工具）",
    handler: async (args, ctx) => {
      const arg = args?.trim();
      const current = readFeedbackState();
      let next: boolean;
      if (arg === "on") next = true;
      else if (arg === "off") next = false;
      else if (arg === "toggle" || !arg) next = !current;
      else {
        ctx.ui.notify(`未知参数：${arg}。用法 /subagent:feedback on|off|toggle`, "error");
        return;
      }

      if (next && !buildToolsFromNames(pi.getActiveTools()).tools) {
        ctx.ui.notify("反馈模式拒绝开启：当前未检测到 be-* 工具（better-edit-tools 未连接）。", "error");
        return;
      }
      writeFeedbackState(next);
      ctx.ui.notify(
        `subagent 反馈模式已${next ? "开启" : "关闭"}。${next ? "新 worker 仅限 read/bash/be-*；运行中的 worker 不受影响。" : ""}`,
        next ? "warning" : "info",
      );
    },
  });

  // ═══════════════════════════
  // /gui:subagents — 异步启动实时监视窗口
  // ═══════════════════════════

  pi.registerCommand("gui:subagents", {
    description: "GUI：异步启动实时监视窗口（不阻塞命令；反馈开关由窗口内直接持久化）",
    handler: async (_args, ctx) => {
      // 非阻塞拉起：不等待 response / 窗口关闭，反馈开关由 GUI 内 SaveSubagentFeedback 持久化
      const result = launchGuiWindow("subagents", {
        feedback: readFeedbackState(),
        workers: getSnapshot(),
      });

      if (!result.ok) {
        ctx.ui.notify(
          result.reason === "unavailable" ? "未找到 wails-gui，请先构建" : "GUI 启动失败（spawn 错误）",
          "error",
        );
      }
    },
  });

  // ═══════════════════════════
  // /trident-models — 查看/切换模型路由
  // ═══════════════════════════

  pi.registerCommand("trident-models", {
    description: "查看/切换三叉戟模型路由配置",
    handler: async (args, ctx) => {
      if (!fs.existsSync(ROLES_PATH)) {
        ctx.ui.notify("providers.roles.toml 不存在。", "warning");
        return;
      }

      const content = fs.readFileSync(ROLES_PATH, "utf-8");
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
            fs.writeFileSync(ROLES_PATH, newContent, "utf-8");
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
  // /gui:trident-setup — GUI 选模型
  // ═══════════════════════════

  pi.registerCommand("gui:trident-setup", {
    description: "GUI：选择模型配置三叉戟路由",
    handler: async (_args, ctx) => {
      if (!findGuiBinary()) {
        ctx.ui.notify("未找到 wails-gui，请先构建", "error");
        return;
      }

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
        if (fs.existsSync(ROLES_PATH)) {
          roles = parseRolesToml(fs.readFileSync(ROLES_PATH, "utf-8"));
        } else if (fs.existsSync(examplePath)) {
          roles = parseRolesToml(fs.readFileSync(examplePath, "utf-8"));
        }
      } catch {}

      ctx.ui.notify("正在启动模型选择器...", "info");

      const result = await runGuiWindow("setup", { models, roles }, { timeoutMs: 120_000 });

      if (!result.ok || result.data?.cancelled) {
        ctx.ui.notify("已取消。", "warning");
        return;
      }

      if (!result.data.roles) {
        ctx.ui.notify("无效的响应。", "error");
        return;
      }

      let toml = "# 三叉戟模型路由配置\n# 由 /gui:trident-setup 生成\n\n[roles]\n";
      for (const role of ["oc", "worker"]) {
        if (result.data.roles[role]) {
          toml += `${role} = "${result.data.roles[role]}"\n`;
        }
      }

      try {
        if (fs.existsSync(ROLES_PATH)) {
          const original = fs.readFileSync(ROLES_PATH, "utf-8");
          const workersMatch = original.match(/\[workers\.\w+\][\s\S]*/);
          if (workersMatch) toml += "\n" + workersMatch[0];
        }
      } catch {}

      fs.writeFileSync(ROLES_PATH, toml, "utf-8");
      ctx.ui.notify("配置已保存到 providers.roles.toml，/reload 生效", "info");
    },
  });
}
