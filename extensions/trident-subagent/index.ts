// trident-subagent — 同步 subagent 派发
//
// subagent({ task: string | Brief | (string | Brief)[], skills?: string[] })：主 agent 整理好完整任务简报后调用，
// 同步等待全部 worker 返航（success/failed/aborted/timeout 逐项汇报）。
// 默认模型优先级：显式 model > subagent 独立默认 > 当前会话模型；可由用户命令设置独立默认。
// skills 可按简报逐 worker 指定。
// /subagent:gui：异步启动实时监视窗口（Wails 窗口轮询状态文件，不阻塞命令）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { launchGuiWindow, runGuiWindow } from "../../lib/gui-runner.ts";
import { buildSafeWorkerTools } from "./worker-tools.ts";
import { runBatch, type BatchItemResult } from "./batch.ts";
import { beginDiagnostics, clearDiagnosticsContext } from "./diagnostics.ts";
import { commandDigest, isWorkerApprovalCapability, needsHumanApproval, validateCapabilityRequest, type CapabilityApproval, type CapabilityGrant, type CapabilityRequest, type CapabilityReview } from "../../lib/subagent-capability.ts";
import { createReviewCache, formatReviewNote, loadLlmReviewConfig, reviewCommand } from "../sandbox-permissions/llm-review.ts";
import { checkCommand } from "../../lib/sandbox-check.ts";
import type { TokenRule } from "../sandbox-permissions/rule-engine.ts";
import { beginBatch, flushStatusFile, getSnapshot, onSnapshotChange, updateWorker, type WorkerRun } from "./status.ts";
import {
  FleetView,
  createCoalescer,
  formatWorkerOutput,
  projectFleet,
  workerOutputBudget,
  type FleetWorkerView,
} from "./dispatch-view.ts";
import { buildSkillIndex, formatUnresolvedSkills, resolveSkillRefs } from "./skill-refs.ts";
import {
  SUBAGENT_MODEL_SCOPE,
  modelLabel,
  preferredModelSpec,
  readSelectedModel,
  resolveConfiguredModel,
  selectScopedDefaultModel,
} from "../../lib/model-selection.ts";
import { normalizeWorkerBrief, type WorkerBriefInput } from "../../lib/subagent-brief.ts";
import { SUBAGENT_PROMPT } from "../../lib/subagent-run.ts";

const CAPABILITY_GUI_TIMEOUT_MS = 3_600_000;
/**
 * fleet 实时投影投递间隔：N 个 worker 的更新合并到这一档，足够「看得出在动」。
 */
const FLEET_EMIT_INTERVAL_MS = 150;
/**
 * fleet 节拍：即使所有 worker 都无事件也要定期重投影。
 *
 * 两个作用：
 *   - 静默/耗时能真正往前走（否则「卡了 40 秒」永远是 0，回到看不出死活的老问题）；
 *   - 行组件在纯思考期也有帧可刷。
 *
 * 250ms 比显示精度（秒级）高至少一档：无事件时秒数最多晚 250ms 才翻。
 */
const FLEET_TICK_MS = 250;
let capabilityApprovalTail: Promise<void> = Promise.resolve();
const capabilityReviewCache = createReviewCache();

function enqueueCapabilityApproval<T>(work: () => Promise<T>): Promise<T> {
  const run = capabilityApprovalTail.then(work, work);
  capabilityApprovalTail = run.then(() => undefined, () => undefined);
  return run;
}

/** 写入 capability 审批审计；只记录稳定的审核 verdict，不把审核意见全文重复塞进条目。 */
export function appendCapabilityApprovalAudit(
  pi: Pick<ExtensionAPI, "appendEntry">,
  request: CapabilityRequest,
  action: "allow" | "deny",
  comment: string | undefined,
  review: CapabilityReview | undefined,
): void {
  const payload: {
    capability: string;
    command: string;
    decision: "allow" | "deny";
    comment?: string;
    review?: { verdict: CapabilityReview["verdict"] };
  } = {
    capability: request.capability,
    command: request.command,
    decision: action,
  };
  const trimmed = comment?.trim();
  if (trimmed) payload.comment = trimmed;
  if (review) payload.review = { verdict: review.verdict };
  pi.appendEntry("subagent-capability-approval", payload);
}

async function approveCapability(
  pi: ExtensionAPI,
  request: CapabilityRequest,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<CapabilityApproval | undefined> {
  const validated = validateCapabilityRequest(request);
  if (!validated || !isWorkerApprovalCapability(validated.capability)) return undefined;

  // 所有 worker 能力请求先过审核模型（与主会话 bash 审批链一致）：
  // safe + auto 直接放行；risky/dangerous/error/无意见一律回退人工弹窗。
  // 审核调用异常按 error 处理（fail-closed），绝不静默放行。
  const reviewConfig = loadLlmReviewConfig();
  let rules: TokenRule[] = [];
  let review: CapabilityReview;
  try {
    rules = checkCommand(validated.command, { cwd: validated.cwd }).rules ?? [];
    review = await reviewCommand(pi, ctx, validated.command, rules, signal, capabilityReviewCache, reviewConfig);
  } catch {
    review = { verdict: "error", reason: "审核调用异常，回退人工确认", suggestion: "" };
  }

  const grant: CapabilityGrant = {
    capability: validated.capability,
    commandDigest: commandDigest(validated.command),
  };

  if (!needsHumanApproval(review, reviewConfig.mode)) {
    appendCapabilityApprovalAudit(pi, validated, "allow", undefined, review);
    return { grant, review };
  }

  const result = await runGuiWindow(
    "gate",
    {
      kind: "capability",
      command: validated.command,
      taskId: validated.taskId,
      capability: validated.capability,
      scope: validated.scope,
      requestReason: validated.reason,
      rules,
      review,
    },
    { timeoutMs: CAPABILITY_GUI_TIMEOUT_MS, signal },
  );
  let allow = result.ok && result.data?.action === "allow";
  let comment = result.ok && typeof result.data?.comment === "string"
    ? result.data.comment.trim()
    : undefined;
  if (!allow && (!result.ok || result.data?.action !== "deny") && ctx?.hasUI) {
    // TUI 回退也带审核简报，人工确认前能看到模型意见
    const reviewNote = review.reason || review.suggestion || review.opinion
      ? `\n\n${formatReviewNote(review)}`
      : "";
    const choice = await ctx.ui.select(
      `⚠️ subagent 请求额外能力：${validated.capability}\n\n${validated.scope ?? ""}\n${validated.reason}${reviewNote}\n\n命令：${validated.command}`,
      ["✅ 允许本次命令", "❌ 拒绝"],
    );
    allow = choice?.includes("允许") ?? false;
    // TUI 只有二选一，没有附言输入；保持 comment 未定义。
    comment = undefined;
  }
  const action = allow ? "allow" : "deny";
  appendCapabilityApprovalAudit(pi, validated, action, comment, review);
  return allow ? { grant, review, ...(comment ? { comment } : {}) } : { review, ...(comment ? { comment } : {}) };
}

/**
 * 工具文本面的摘要行（模型可见）。
 *
 * 刻意只放一行计数：表格、吞吐、sparkline 全部走 details + renderResult，
 * 不经 content 进模型上下文。
 */
function fleetSummaryText(workers: WorkerRun[]): string {
  const total = workers.length;
  const queued = workers.filter((w) => w.status === "queued").length;
  const done = workers.filter((w) => w.status === "success").length;
  const bad = workers.filter((w) => w.status === "failed" || w.status === "aborted" || w.status === "timeout").length;
  const wait = workers.filter((w) => w.status === "needs_approval").length;
  const running = Math.max(0, total - queued - done - bad - wait);
  const capacity = queued > 0 ? `（${queued} 排队中）` : "";
  return `${total} 个 subagent：运行 ${running} / 完成 ${done} / 异常 ${bad} / 等待权限 ${wait}${capacity}（表格见工具行，/subagent:gui 可开实时窗口）`;
}


export default function (pi: ExtensionAPI) {
  // 子进程内不注册派发工具，防递归
  if (process.env.PI_SUBAGENT) return;

  const briefSchema = Type.Object({
    objective: Type.String({ description: "必须：worker 要完成的具体目标，不要只写调查主题。" }),
    context: Type.Optional(Type.String({ description: "必要背景、已知现状、已有结论或用户约束。" })),
    constraints: Type.Optional(Type.Array(Type.String(), { description: "必须遵守的边界、不可改动项、权限或兼容性要求。" })),
    required_files: Type.Optional(Type.Array(Type.String(), { description: "worker 必须先阅读的文件、目录、日志或设计文档。" })),
    skills: Type.Optional(Type.Array(Type.String(), { description: "本 worker 专用 skill 名；只加载完成任务确实需要的 skill。" })),
    acceptance: Type.Optional(Type.Array(Type.String(), { description: "可验证的验收标准、测试命令或交付物。" })),
    output_format: Type.Optional(Type.String({ description: "期望 worker 最终回报的结构，例如结论、改动、测试、风险。" })),
  });

  // ═══════════════════════════
  // subagent model — 用户侧独立 worker 模型设置
  // ═══════════════════════════

  const workerModelCommand = {
    description: "选择、切换或恢复 subagent 默认 worker 模型（不改变当前 session）：[provider/model]",
    handler: async (args: string, ctx: ExtensionContext) => {
      const result = await selectScopedDefaultModel(
        ctx,
        SUBAGENT_MODEL_SCOPE,
        args.trim() || undefined,
        "当前 session 模型",
      );
      if (!ctx.hasUI) return;
      if (!result.ok) {
        if (result.reason !== "cancelled") ctx.ui.notify("subagent 默认模型选择失败，请检查 provider/model 和认证。", "warning");
        return;
      }
      if (result.action === "inherit") {
        ctx.ui.notify("subagent 已恢复继承当前 session 模型", "info");
      } else {
        ctx.ui.notify(`subagent 默认 worker 模型：${modelLabel(result.model)}（不改变当前 session）`, "info");
      }
    },
  };
  pi.registerCommand("subagent:select-default-worker-model", workerModelCommand);
  pi.registerCommand("subagent:change-default-worker-model", workerModelCommand);
  pi.registerCommand("subagent:switch-default-worker-model", workerModelCommand);
  pi.registerCommand("subagent:select-change-switch-default-worker-model", workerModelCommand);

  // ═══════════════════════════
  // subagent — 唯一派发入口（同步并发）
  // ═══════════════════════════

  pi.registerTool({
    name: "subagent",
    label: "Dispatch Subagent",
    description:
      "将完整任务简报派给一个或多个隔离 worker。复杂任务请显式传 objective、context、constraints、required_files、skills、acceptance、output_format；同步等待所有 worker 进入终态后返回。",
    promptSnippet: "Dispatch side-quests with complete context, required files, skills, acceptance criteria, and wait for all results",
    promptGuidelines: [
      "不要把用户原话原封不动转发；先整理成 worker 可直接执行的完整简报。",
      "复杂任务优先传结构化 task：objective 必填；context 写已知现状；constraints 写边界；required_files 写必看文件；skills 只填确实需要的 skill；acceptance 写可验证标准；output_format 写回报格式。",
      "如果多个任务互相独立，传结构化对象数组并行执行；每项都要自洽，不能依赖主 agent 中途补背景。",
      "模型优先级是：显式 model 参数 > 用户通过 /subagent:select-change-switch-default-worker-model 设置的独立默认 > 当前主 session 模型。显式参数只影响本次 worker；独立默认不修改主 session。",
      "skills 会按 worker 简报分别加载；不要为了保险把所有 skill 都传进去。",
      "判断标准：多步操作、涉及多个文件、需要独立上下文 → subagent；否则自己动手。",
      "不要派会挂很久的活：工具是同步阻塞的，一个卡住的 worker 会把主对话钉住。典型禁派：无超时的网络请求（curl/下载/接口探测）、靠脚本自己扩大范围的调查（递归扫描、批量爬取、循环里 spawn 子进程、反复重试的探查）、全量构建/完整测试套件、常驻或交互式命令（dev server、watch、tail -f）。要派就先拆小，并在简报里要求命令带显式超时。",
      "工具同步阻塞直到所有 worker 结束；一个失败不终止其他 worker，逐项汇报。",
      "运行期间可用 /subagent:gui 查看实时详情；失败 investigation 路径先读「读档指引」与「最终结论」。",
    ],
    parameters: Type.Object({
      task: Type.Union([
        Type.String({ description: "兼容：单个完整任务说明；复杂任务应使用结构化简报。" }),
        briefSchema,
        Type.Array(Type.Union([Type.String(), briefSchema]), { description: "多个独立任务简报，并行执行；每项都应包含完整上下文与验收标准。" }),
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
          description: "可选：worker 使用的已注册模型，格式 provider/model；不传时按独立默认 worker 模型，再回退到当前主 session 模型。",
        }),
      ),
    }),
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const raw = args.task;
      const count = Array.isArray(raw) ? raw.length : 1;
      let content = theme.fg("toolTitle", theme.bold("subagent "));
      content += theme.fg("muted", `${count} 个 worker`);
      if (typeof args.model === "string" && args.model) content += theme.fg("dim", ` · ${args.model}`);
      if (typeof args.sandbox_profile === "string" && args.sandbox_profile) {
        content += theme.fg("dim", ` · ${args.sandbox_profile}`);
      }
      if (Array.isArray(args.skills) && args.skills.length > 0) {
        content += theme.fg("dim", ` · skills ${args.skills.length}`);
      }
      text.setText(content);
      return text;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      // details.fleet 已是展示投影（不含 timeline/任务全文），直接交给行组件；
      // 不要在渲染期重投影——那会把投影当 WorkerRun 再投影一次，表格会全是 0。
      const fleet = ((result.details ?? {}) as { fleet?: FleetWorkerView[] }).fleet;
      const previous = context.lastComponent;
      // 行组件必须跨帧复用，否则瞬时速率历史（sparkline）每帧归零
      const view = previous instanceof FleetView
        ? previous
        : new FleetView(theme, expanded, undefined, (isExpanded) =>
            keyHint("app.tools.expand", isExpanded ? "收起明细" : "展开明细"));
      view.update(fleet ?? [], theme, expanded);
      if (isPartial && (fleet === undefined || fleet.length === 0)) {
        return new Text(theme.fg("warning", "启动 worker…"), 0, 0);
      }
      return view;
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const rawTasks: Array<string | WorkerBriefInput> = Array.isArray(params.task) ? params.task : [params.task];
      if (rawTasks.length === 0) {
        return { content: [{ type: "text", text: "错误：任务列表为空。" }], details: { error: "empty_batch" } };
      }

      const normalized = rawTasks.map((task) => normalizeWorkerBrief(task, params.skills ?? []));
      const tasks = normalized.map((brief) => brief.task);

      const scopedDefault = await readSelectedModel(SUBAGENT_MODEL_SCOPE);
      const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const preferred = preferredModelSpec(
        params.model,
        scopedDefault,
        sessionModel,
      );
      let workerModel = "";
      if (preferred) {
        const selected = resolveConfiguredModel(ctx, preferred.spec);
        if (!selected.ok) {
          const source = preferred.source === "scoped-default" ? "subagent 独立默认" : "worker";
          const reason = selected.reason === "unauthenticated"
            ? `${source}模型未配置认证：${preferred.spec}`
            : selected.reason === "invalid_spec"
              ? `${source}模型格式无效：${preferred.spec || "（空）"}`
              : `找不到${source}模型 ${preferred.spec}。请使用已注册的 provider/model。`;
          return {
            content: [{ type: "text", text: `错误：${reason}` }],
            details: {
              error: `worker_model_${selected.reason}`,
              model: preferred.spec,
              source: preferred.source,
            },
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
      // skill 引用解析（pi 的权威发现结果 + 显式路径直通）。
      // 解析不到就**整批拒绝**：旧的静默丢弃会让主 agent 以为加载了、其实 worker 什么都没拿到。
      // 拒绝点前移到 spawn 之前，避免白烧一轮 worker。报错里直接列出可用名称，主 agent 自己重选。
      const skillIndex = buildSkillIndex({ cwd: ctx.cwd, agentDir: getAgentDir() });
      const sharedSkills = resolveSkillRefs(params.skills ?? [], skillIndex, ctx.cwd);
      const perWorkerSkills = normalized.map((brief) => resolveSkillRefs(brief.skills, skillIndex, ctx.cwd));
      const unresolvedSkills = [
        ...new Set([...sharedSkills.unresolved, ...perWorkerSkills.flatMap((r) => r.unresolved)]),
      ];
      if (unresolvedSkills.length > 0) {
        return {
          content: [{ type: "text", text: formatUnresolvedSkills(unresolvedSkills, skillIndex) }],
          details: { error: "unresolved_skills", unresolved: unresolvedSkills },
        };
      }
      const workerSkills = perWorkerSkills.map((r) => r.paths);
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
      // 永久本地诊断档案：只保存父进程可验证的可见轨迹和 prompt 重建输入。
      // Pi 尚无官方 API 回传 worker 最终 resolved system prompt，绝不通过 payload
      // 截获或其他旁路伪造/采集隐藏上下文。
      beginDiagnostics({
        batchId: batchTaskId,
        createdAt: new Date().toISOString(),
        cwd: ctx.cwd,
        model: workerModel,
        workerPrompt: SUBAGENT_PROMPT,
        systemPrompt: {
          kind: "reconstructable-input",
          stableInstruction: SUBAGENT_PROMPT,
          skillPaths: workerSkills,
          tools: safeTools,
          extraExtensions: [],
        },
      });
      // 实时投影投递：worker 每次快照变更都推一份紧凑投影给工具行渲染。
      // 两条限流叠加：worker 侧 emitUpdate 已按增量节流，这里再按 worker 数合并
      // （N 个 worker 各自更新 → 最多每 FLEET_EMIT_INTERVAL_MS 一次），且最后一次
      // 必然送达。details 只装投影（不含 timeline/对话），content 保持一行不动。
      const emitFleet = createCoalescer<WorkerRun[]>(FLEET_EMIT_INTERVAL_MS, (workers) => {
        onUpdate?.({
          content: [{ type: "text", text: fleetSummaryText(workers) }],
          details: { phase: "running", fleet: projectFleet(workers, Date.now()) },
        });
      });
      const unsubscribeFleet = onSnapshotChange((workers) => emitFleet.push(workers));
      emitFleet.push(getSnapshot()); // 首帧（全部 starting）立即送达
      // 节拍：无事件时也定期重投影，让静默时长与帧刷新继续前进
      const fleetTick = setInterval(() => emitFleet.push(getSnapshot()), FLEET_TICK_MS);
      fleetTick.unref?.();

      let results: BatchItemResult[];
      try {
        results = await runBatch(tasks, {
          cwd: ctx.cwd,
          sandboxDir: params.sandbox_dir,
          readonly: workerReadonly,
          model: workerModel,
          signal,
          skills: sharedSkills.paths,
          workerSkills,
          tools: safeTools,
          taskId: batchTaskId,
          onCapabilityRequest: (request, workerId) => enqueueCapabilityApproval(() => approveCapability(
            pi,
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
        // 先停节拍、退订，再 flush：收尾帧用最后一份快照，且不再接受新推送
        clearInterval(fleetTick);
        unsubscribeFleet();
        emitFleet.flush();
        // 挂起合并写显式落盘（终态已立即写，此处兜底，确保进程结束前不丢状态）
        flushStatusFile();
        clearDiagnosticsContext();
      }

      const budget = workerOutputBudget(results.length);
      const lines = results.map((r) => {
        const head = `#${r.index + 1} ${r.status.toUpperCase()}`;
        const meta = r.exitCode !== undefined ? ` exit=${r.exitCode}` : "";
        const err = r.errorMessage ? ` error=${r.errorMessage.slice(0, 300)}` : "";
        const reviewBrief = r.capabilityReview ? `\n  简报: ${formatReviewNote(r.capabilityReview)}` : "";
        const capability = r.capabilityRequest
          ? `\n  needs_approval: ${r.capabilityRequest.capability} — ${r.capabilityRequest.scope}\n  command: ${r.capabilityRequest.command.slice(0, 500)}${reviewBrief}`
          : "";
        const stderr = r.stderr.trim() ? `\n  stderr: ${r.stderr.trim().slice(0, 500)}` : "";
        // inlineSummary 通常已含 investigation 路径；未含才补，避免重复
        const inv = r.investigationPath && !r.output.includes(r.investigationPath)
          ? `\n  investigation: ${r.investigationPath}\n  读档：先看该文件「读档指引」与「最终结论」`
          : "";
        return `${head}${meta}${err}${capability}${stderr}${inv}\n  ${formatWorkerOutput(r.output, budget)}`;
      });

      const failedCount = results.filter((r) => r.status === "failed" || r.status === "aborted" || r.status === "timeout").length;
      const approvalCount = results.filter((r) => r.status === "needs_approval").length;
      onUpdate?.({
        content: [{
          type: "text",
          text: `${tasks.length} 个 subagent 已全部返航（成功 ${tasks.length - failedCount - approvalCount} / 失败 ${failedCount} / 等待权限 ${approvalCount}）`,
        }],
        details: { phase: "done", results, fleet: projectFleet(getSnapshot(), Date.now()) },
      });

      return {
        content: [{
          type: "text",
          text: `subagent 全部返航（${tasks.length - failedCount - approvalCount}/${tasks.length} 成功，失败 ${failedCount}，等待权限 ${approvalCount}）：\n\n${lines.join("\n\n")}`,
        }],
        details: { results, fleet: projectFleet(getSnapshot(), Date.now()) },
      };
    },
  });

  // ═══════════════════════════
  // /subagent:gui — 异步启动实时监视窗口
  // ═══════════════════════════

  const subagentsGuiHandler = async (_args: string, ctx: ExtensionContext) => {
    // 非阻塞拉起：不等待 response / 窗口关闭
    const result = launchGuiWindow("subagents", {
      workers: getSnapshot(),
    });

    if (!result.ok) {
      ctx.ui.notify(
        result.reason === "unavailable" ? "未找到 wails-gui，请先构建" : "GUI 启动失败（spawn 错误）",
        "error",
      );
    }
  };

  pi.registerCommand("subagent:gui", {
    description: "打开 subagent 实时监视 GUI（不阻塞命令）",
    handler: subagentsGuiHandler,
  });

  pi.registerCommand("gui:subagents", {
    description: "兼容别名：打开 subagent 实时监视 GUI（请改用 /subagent:gui）",
    handler: async (args, ctx) => {
      ctx.ui.notify("/gui:subagents 已废弃，请使用 /subagent:gui", "warning");
      return subagentsGuiHandler(args, ctx);
    },
  });
}
