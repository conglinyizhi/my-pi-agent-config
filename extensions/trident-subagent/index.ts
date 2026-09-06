// trident-subagent — 同步 subagent 派发 + 反馈模式开关
//
// subagent({ task: string | string[], skills?: string[] })：主 agent 整理好完整任务说明后调用，
// 同步等待全部 worker 返航（success/failed/aborted/timeout 逐项汇报）。
// 模型直接用当前会话模型（ctx.model），不再从配置文件决定；skills 可选，把指定 skill 加载给 worker。
// /subagent:feedback on|off|toggle：后续新启动 worker 只允许 read/bash/be-* 工具。
// /gui:subagents：异步启动实时监视窗口（Wails 窗口轮询状态文件，不阻塞命令）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { launchGuiWindow, runGuiWindow } from "../../lib/gui-runner.ts";
import { readFeedbackState, writeFeedbackState, buildSafeWorkerTools, buildToolsFromNames } from "./feedback.ts";
import { runBatch, type BatchItemResult } from "./batch.ts";
import { commandDigest, isWorkerApprovalCapability, validateCapabilityRequest, type CapabilityGrant, type CapabilityRequest } from "../../lib/subagent-capability.ts";
import { beginBatch, flushStatusFile, getSnapshot, updateWorker, type WorkerRun } from "./status.ts";
import { resolveConfiguredModel, modelLabel } from "../../lib/model-selection.ts";

const BE_ERROR_RECORDER = path.join(os.homedir(), ".pi", "agent", "extensions", "be-error-recorder", "index.ts");
const CAPABILITY_GUI_TIMEOUT_MS = 3_600_000;
let capabilityApprovalTail: Promise<void> = Promise.resolve();

function enqueueCapabilityApproval<T>(work: () => Promise<T>): Promise<T> {
  const run = capabilityApprovalTail.then(work, work);
  capabilityApprovalTail = run.then(() => undefined, () => undefined);
  return run;
}

async function approveCapability(
  request: CapabilityRequest,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<CapabilityGrant | undefined> {
  const validated = validateCapabilityRequest(request);
  if (!validated || !isWorkerApprovalCapability(validated.capability)) return undefined;
  const result = await runGuiWindow(
    "gate",
    {
      kind: "capability",
      command: request.command,
      taskId: request.taskId,
      capability: request.capability,
      scope: request.scope,
      requestReason: request.reason,
      rules: [],
    },
    { timeoutMs: CAPABILITY_GUI_TIMEOUT_MS, signal },
  );
  let allow = result.ok && result.data?.action === "allow";
  if (!allow && (!result.ok || result.data?.action !== "deny") && ctx?.hasUI) {
    const choice = await ctx.ui.select(
      `⚠️ subagent 请求额外能力：${request.capability}\n\n${request.scope ?? ""}\n${request.reason}\n\n命令：${request.command}`,
      ["✅ 允许本次命令", "❌ 拒绝"],
    );
    allow = choice?.includes("允许") ?? false;
  }
  if (!allow) return undefined;
  return { capability: request.capability, commandDigest: commandDigest(request.command) };
}

// 把 skill 名解析成绝对路径（目录含 SKILL.md）：在 ~/.pi/agent/skills 下按名匹配，含一层子目录
function resolveSkillPaths(names: string[]): string[] {
  const root = path.join(os.homedir(), ".pi", "agent", "skills");
  const out: string[] = [];
  for (const name of names) {
    const found = findSkillDir(root, name);
    if (found) out.push(found);
  }
  return out;
}

function findSkillDir(root: string, name: string): string | undefined {
  if (fs.existsSync(path.join(root, name, "SKILL.md"))) return path.join(root, name);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(root, entry.name, name, "SKILL.md");
    if (fs.existsSync(p)) return path.join(root, entry.name, name);
  }
  return undefined;
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
      "subagent 是支线任务执行系统。参数必须是你自己整理好的完整任务说明（含目标、约束、验收标准），不是用户原始发言。",
      "判断标准：多步操作、涉及多个文件、需要独立上下文 → subagent；否则你自己动手。",
      "可选 model 参数使用 provider/model 覆盖 worker 模型；不传时 worker 继承当前主 session 模型。它只影响本次 worker，不会修改主 session。",
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
      skills: Type.Optional(
        Type.Array(Type.String(), {
          description: "可选：要提供给 worker 的 skill 名（如 \"moonbit-orientation\"），按名在 ~/.pi/agent/skills 下解析并加载给 worker；不传则 worker 不加载任何 skill",
        }),
      ),
      sandbox_profile: Type.Optional(
        Type.Union([
          Type.Literal("readonly"),
          Type.Literal("worktree"),
        ], {
          description:
            "worker 沙箱档位：readonly=默认只读 workspace；worktree=只能写 sandbox_dir。未指定时，有 sandbox_dir 则按 worktree，否则按 readonly。",
        }),
      ),
      sandbox_dir: Type.Optional(
        Type.String({
          description:
            "worktree 档位必填的绝对路径：worker 只能写该目录及其子目录，工程其余部分只读。",
        }),
      ),
      readonly: Type.Optional(
        Type.Boolean({
          description: "兼容字段：true 强制 readonly；安全默认是不传 sandbox_dir 时自动 readonly。",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "可选：worker 使用的已注册模型，格式 provider/model；不传则继承当前主 session 模型。",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const tasks: string[] = Array.isArray(params.task) ? params.task : [params.task];
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "错误：任务列表为空。" }], details: { error: "empty_batch" } };
      }

      // 模型不再从配置文件决定：直接用当前会话模型作为 subagent 模型
      let workerModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
      if (params.model !== undefined) {
        const requestedModel = typeof params.model === "string" ? params.model.trim() : "";
        const selected = requestedModel
          ? resolveConfiguredModel(ctx, requestedModel)
          : { ok: false as const, reason: "invalid_spec" as const };
        if (!selected.ok) {
          const reason = selected.reason === "unauthenticated"
            ? `worker 模型未配置认证：${requestedModel}`
            : `找不到 worker 模型 ${requestedModel || "（空）"}。请使用已注册的 provider/model。`;
          return {
            content: [{ type: "text", text: `错误：${reason}` }],
            details: { error: `worker_model_${selected.reason}`, model: requestedModel },
          };
        }
        workerModel = modelLabel(selected.model);
      }
      if (!workerModel) {
        return {
          content: [{ type: "text", text: "错误：当前 session 没有可用模型，无法启动 worker。请先设置当前 session 模型。" }],
          details: { error: "missing_worker_model" },
        };
      }
      const feedbackOn = readFeedbackState();
      const profile = params.sandbox_profile
        ?? (params.sandbox_dir ? "worktree" : "readonly");
      if (profile === "worktree" && !params.sandbox_dir) {
        return {
          content: [{ type: "text", text: "错误：sandbox_profile=worktree 必须同时提供 sandbox_dir。" }],
          details: { error: "missing_sandbox_dir" },
        };
      }
      const workerReadonly = profile === "readonly" || params.readonly === true;
      const activeTools = pi.getActiveTools();
      const safeTools = buildSafeWorkerTools(activeTools);
      if (!safeTools.includes("bash") || !safeTools.includes("read")) {
        return {
          content: [{ type: "text", text: "错误：当前活跃工具集缺少 worker 必需的 read/bash，拒绝启动未受限的 worker。" }],
          details: { error: "missing_safe_worker_tools" },
        };
      }
      const toolCfg = feedbackOn
        ? buildToolsFromNames(activeTools)
        : { tools: safeTools };
      if (!toolCfg.tools || !toolCfg.tools.includes("bash") || !toolCfg.tools.includes("read")) {
        return {
          content: [{ type: "text", text: "错误：反馈模式的安全工具白名单不可用，拒绝启动 worker。" }],
          details: { error: "invalid_feedback_tools" },
        };
      }

      // batch-scoped inbox id：`batch-${base36 timestamp}-${compact randomUUID}-w${i+1}`
      // 只含 [A-Za-z0-9_-]（base36 小写 + 32 位 hex + 分隔符），长度 ~50 << 128；
      // 同一 id 同时交给 runBatch（不得按任务位置重算）。randomUUID 去连字符防歧义。
      const batchStamp = Date.now().toString(36);
      const batchNonce = randomUUID().replace(/-/g, "");
      const runs: WorkerRun[] = tasks.map((task, i) => ({
        id: `w${i + 1}`,
        inboxId: `batch-${batchStamp}-${batchNonce}-w${i + 1}`,
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
          sandboxDir: params.sandbox_dir,
          readonly: workerReadonly,
          model: workerModel,
          signal,
          skills: resolveSkillPaths(params.skills ?? []),
          tools: toolCfg.tools,
          extraExtensions: feedbackOn ? [BE_ERROR_RECORDER] : undefined,
          taskId: batchTaskId,
          onCapabilityRequest: (request, workerId) => enqueueCapabilityApproval(() => approveCapability(
            request,
            ctx,
            signal,
          )),
          // 与 runs 一一对应：每个 worker 拿到本批分配的唯一 inbox id
          workerInboxIds: runs.map((r) => r.inboxId),
        });
      } catch (err) {
        // 批量前置失败（workerInboxIds 非法 / inbox 预创建失败）：无任何 worker 被 spawn。
        // 把整批标记为 failed 终态，避免 GUI 显示半途悬挂；落盘后以错误文本返回（不抛）。
        const msg = err instanceof Error ? err.message : String(err);
        const finishedAt = new Date().toISOString();
        for (const run of runs) updateWorker(run.id, { status: "failed", finishedAt });
        flushStatusFile();
        onUpdate?.({
          content: [{ type: "text", text: `subagent 批量启动失败：${msg}` }],
          details: { phase: "done", error: msg },
        });
        return {
          content: [{ type: "text", text: `subagent 批量启动失败：${msg}` }],
          details: { error: msg },
        };
      } finally {
        // 挂起合并写显式落盘（终态已立即写，此处兜底，确保进程结束前不丢状态）
        flushStatusFile();
      }

      const lines = results.map((r) => {
        const head = `#${r.index + 1} ${r.status.toUpperCase()}`;
        const meta = r.exitCode !== undefined ? ` exit=${r.exitCode}` : "";
        const err = r.errorMessage ? ` error=${r.errorMessage.slice(0, 300)}` : "";
        const capability = r.capabilityRequest
          ? `\n  needs_approval: ${r.capabilityRequest.capability} — ${r.capabilityRequest.scope}\n  command: ${r.capabilityRequest.command.slice(0, 500)}`
          : "";
        const stderr = r.stderr.trim() ? `\n  stderr: ${r.stderr.trim().slice(0, 500)}` : "";
        // inlineSummary 通常已含 investigation 路径；未含才补，避免重复
        const inv = r.investigationPath && !r.output.includes(r.investigationPath)
          ? `\n  investigation: ${r.investigationPath}\n  读档：先看该文件「读档指引」与「最终结论」`
          : "";
        return `${head}${meta}${err}${capability}${stderr}${inv}\n  ${r.output.slice(0, 800)}`;
      });

      const failedCount = results.filter((r) => r.status === "failed" || r.status === "aborted" || r.status === "timeout").length;
      const approvalCount = results.filter((r) => r.status === "needs_approval").length;
      onUpdate?.({
        content: [{
          type: "text",
          text: `${tasks.length} 个 subagent 已全部返航（成功 ${tasks.length - failedCount - approvalCount} / 失败 ${failedCount} / 等待权限 ${approvalCount}）`,
        }],
        details: { phase: "done", results },
      });

      return {
        content: [{
          type: "text",
          text: `subagent 全部返航（${tasks.length - failedCount - approvalCount}/${tasks.length} 成功，失败 ${failedCount}，等待权限 ${approvalCount}）：\n\n${lines.join("\n\n")}`,
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

}
