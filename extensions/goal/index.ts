// /goal — 目标自动续行插件
//
// 用法：
//   /goal                          — 显示帮助
//   /goal 汉化这张地图              — 启动（自动检测 <summary> XML）
//   /goal gate:pnpm test 让测试全过 — 启动 + 每轮额外跑验证命令
//   /goal off                      — 关闭
//   /goal status                   — 查看状态
//
// 工作原理：
//   每轮 agent 停歇后：
//  1. 检测最后一条 assistant 消息是否含 <summary> XML
//      - 有且 <next> 为空 → 任务完成（再过 gate 验证）
//      - 有且 <next> 有待办 → 续行
//      - 没有 → 跳过 XML 检测，走 gate 或直接续行
//   2. 如果指定了 gate 命令，执行它
//      - exit 0 → 完成
//      - 非 0 → 把失败输出喂回模型
//   3. 两者都没有 → 直接续行（让模型继续工作）

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearSuppressTaskComplete, markSuppressTaskComplete } from "../../lib/continuation-guard";
import { notify } from "../../lib/notify-send";

// ── 常量 ──

/** 连续相同失败达到此次数 → 暂停 */
const SAME_ERROR_THRESHOLD = 3;
/** 每 N 次循环发一条带声音的通知 */
const PROGRESS_NOTIFY_INTERVAL = 3;
/** gate 输出截断长度 */
const GATE_OUTPUT_MAX = 4000;

// ── XML 结构检测 ──

const SUMMARY_RE = /<summary>[\s\S]*<\/summary>/;
const NEXT_RE = /<next>([\s\S]*?)<\/next>/;
const PLAN_RE = /<plan>([\s\S]*?)<\/plan>/;
/** 整条消息去除空白后恰好是一个 <summary> 块，无任何额外文字 */
const PURE_SUMMARY_RE = /^\s*<summary>[\s\S]*<\/summary>\s*$/;

interface MessageLike {
  content?: string | Array<{ type: string; text?: string }>;
}

function extractText(message: MessageLike): string {
  if (!message?.content) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

/** 返回 "pending" | "done" | "none"（没有 summary结构） */
function checkSummary(text: string): "pending" | "done" | "none" {
  if (!SUMMARY_RE.test(text)) return "none";

  const nextMatch = text.match(NEXT_RE);
  if (nextMatch) {
    const nextContent = nextMatch[1].trim();
    if (/\d+[.)]/.test(nextContent)) return "pending";
    return "done";
  }

  const planMatch = text.match(PLAN_RE);
  if (planMatch) {
    const lines = planMatch[1].split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\d+[.)]/.test(trimmed) && !trimmed.includes("✅")) {
        return "pending";
      }
    }
    return "done";
  }

  return "pending";
}

function extractNext(text: string): string {
  const m = text.match(NEXT_RE);
  return m ? m[1].trim() : "";
}

/** 从纯 <summary> XML 中提取目标描述（取 <next> 内容，回退到 <plan> 首行） */
function extractGoalFromSummary(text: string): string {
  const next = extractNext(text);
  if (next) return next;
  const planMatch = text.match(PLAN_RE);
  if (planMatch) {
    const firstLine = planMatch[1].split("\n").find((l) => l.trim());
    if (firstLine) return firstLine.trim();
  }
  return "";
}

// ── 续行提示词 ──

function buildContinuePrompt(goalDesc: string, nextContent: string): string {
  return [
    "继续执行。直接工作，不需要技能匹配。",
    "",
    goalDesc ? `目标：${goalDesc}` : "",
    "",
    "要求：",
    "1. 继续推进目标",
    "2. 完成后输出更新版的 <summary> XML（更新 <plan>、<progress>、<next>）",
    "3. 如果所有任务已完成，<next> 中写「全部完成」",
    "",
    "完成审计：",
    "- 不要缩小目标或重新定义成功",
    "- 不要因为没有明显剩余工作就标完成，要逐条验证",
    "- 证据不完整就继续干",
    "",
    nextContent ? `待执行：\n${nextContent}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildGateFailPrompt(goalDesc: string, gateCmd: string, failureOutput: string): string {
  return [
    "验证未通过。请修复后重试。直接工作，不需要技能匹配。",
    "",
    goalDesc ? `目标：${goalDesc}` : "",
    `验证命令：\`${gateCmd}\``,
    "",
    "失败输出：",
    "```",
    failureOutput,
    "```",
    "",
    "要求：",
    "1. 分析失败原因并修复",
    "2. 修复后我会自动重新运行验证命令",
    "3. 不要自己运行验证命令，专注于修复代码",
    "4. 不要缩小目标或换一个更容易通过的方案",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── 错误指纹 ──

function errorFingerprint(output: string): string {
  const head = output.slice(0, 500);
  const tail = output.slice(-200);
  return `${head}|||${tail}`
    .replace(/:\d+(:\d+)?/g, ":N")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateOutput(output: string): string {
  if (output.length <= GATE_OUTPUT_MAX) return output;
  const half = Math.floor(GATE_OUTPUT_MAX / 2);
  return `${output.slice(0, half)}\n\n... [截断 ${output.length - GATE_OUTPUT_MAX} 字符] ...\n\n${output.slice(-half)}`;
}

// ── 帮助文本 ──

const HELP_TEXT = [
  "🎯 /goal — 目标自动续行",
  "",
  "用法：",
  "  /goal <目标描述>               启动（自动检测 <summary> XML 续行）",
  "  /goal gate:<命令> [目标描述]    启动 + 每轮额外跑验证命令",
  "  /goal off                     关闭",
  "  /goal status                  查看状态",
  "",
  "示例：",
  "  /goal 汉化这张地图",
  "  /goal gate:pnpm test 让所有测试通过",
  "  /goal gate:cargo build 修复编译错误",
  "",
  "行为：",
  "  • 自动检测模型输出的 <summary> XML 判断进度",
  "  • 可选 gate 命令做客观验证（exit0 = 通过）",
  "  • 无循环上限，跑到完成为止",
  "  • 每 3 轮发一条带声音的进度通知",
  "  • 连续 3 次相同 gate 错误自动暂停",
  "  • 循环期间抑制任务完成通知/音频",
].join("\n");

// ── 扩展主体 ──

export default function (pi: ExtensionAPI) {
  let active = false;
  let continueCount = 0;
  let goalDescription = "";
  let gateCommand = "";

  // gate 错误追踪
  let lastErrorFingerprint = "";
  let sameErrorCount = 0;

  // 自动检测：已询问过的 entry id，避免重复弹窗
  let lastPromptedEntryId = "";

  function resetState() {
    active = false;
    continueCount = 0;
    goalDescription = "";
    gateCommand = "";
    lastErrorFingerprint = "";
    sameErrorCount = 0;
    clearSuppressTaskComplete();
  }

  /** 激活 goal 模式（命令手动触发 / 自动检测共用） */
  function activateGoal(ctx: { ui: { setStatus: (k: string, t: string | undefined) => void; notify: (m: string, t?: "info" | "warning" | "error") => void } }, desc: string, gate: string) {
    active = true;
    continueCount = 0;
    goalDescription = desc;
    gateCommand = gate;
    lastErrorFingerprint = "";
    sameErrorCount = 0;

    const label = gate ? `gate:\`${gate}\`` : desc || "目标";
    ctx.ui.setStatus("goal", "🎯 循环中");
    ctx.ui.notify(`🎯 Goal 已启用（${label}）`, "info");
  }

  async function maybeProgressNotify() {
    if (continueCount > 0 && continueCount % PROGRESS_NOTIFY_INTERVAL === 0) {
      const info = gateCommand ? `gate: ${gateCommand}` : goalDescription;
      await notify("🎯 Goal 进行中", `第 ${continueCount} 轮 | ${info}`, {
        urgency: "low",
        timeout: 5000,
        sound: true,
      });
    }
  }

  function finishGoal(ctx: ExtensionContext, reason: string) {
    const count = continueCount;
    resetState();
    ctx.ui.setStatus("goal", undefined);
    ctx.ui.setWidget("goal-status", undefined);
    ctx.ui.notify(`🎯 Goal 完成：${reason}`, "info");
    notify("🎯 Goal 完成", `${reason} | 共 ${count} 轮`, {
      urgency: "normal",
      timeout: 60_000,
      sound: true,
    });
  }

  function pauseGoal(ctx: ExtensionContext, reason: string, extraMessage?: string) {
    const count = continueCount;
    resetState();
    ctx.ui.setStatus("goal", undefined);
    ctx.ui.setWidget("goal-status", undefined);
    ctx.ui.notify(`🎯 Goal 暂停：${reason}`, "warning");
    notify("🎯 Goal 暂停", `${reason} | 共 ${count} 轮`, {
      urgency: "critical",
      timeout: 60_000,
      sound: true,
    });
    if (extraMessage) {
      setTimeout(() => pi.sendUserMessage(extraMessage), 300);
    }
  }

  function scheduleContinue(prompt: string) {
    setTimeout(() => pi.sendUserMessage(prompt), 300);
  }

  // ── /goal 命令 ──

  pi.registerCommand("goal", {
    description: "目标自动续行",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "off", label: "off", description: "关闭" },
        { value: "status", label: "status", description: "查看状态" },
        { value: "gate:pnpm test ", label: "gate:pnpm test", description: "gate 验证" },
        { value: "gate:cargo test ", label: "gate:cargo test", description: "gate 验证" },
        { value: "gate:make build ", label: "gate:make build", description: "gate 验证" },
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (!trimmed) {
        ctx.ui.notify(HELP_TEXT, "info");
        return;
      }

      if (trimmed === "off" || trimmed === "stop") {
        resetState();
        ctx.ui.setStatus("goal", undefined);
        ctx.ui.setWidget("goal-status", undefined);
        ctx.ui.notify("🎯 Goal 已关闭", "info");
        return;
      }

      if (trimmed === "status") {
        const state = active ? "✅ 活跃" : "❌ 未激活";
        const gateInfo = gateCommand ? ` | gate: ${gateCommand}` : "";
        const errInfo = sameErrorCount > 0 ? ` | 连续相同错误: ${sameErrorCount}` : "";
        ctx.ui.notify(`🎯 Goal: ${state} | 已循环 ${continueCount} 次${gateInfo}${errInfo}`, "info");
        return;
      }

      // 解析：提取 gate: 部分，剩余为目标描述
      let gate = "";
      let desc = trimmed;

      const gateMatch = trimmed.match(/gate:(.+?)(?=\s+[\u4e00-\u9fff]|$)/);
      if (gateMatch) {
        gate = gateMatch[1].trim();
        desc = trimmed.replace(gateMatch[0], "").trim();
      }

      activateGoal(ctx, desc, gate);

      // 有 gate + 有描述：发初始指令让模型开始
      if (gate && desc) {
        scheduleContinue(
          [`目标：${desc}`, "", `完成后我会自动运行 \`${gate}\` 验证。`, "请开始工作。"].join("\n"),
        );
      }
    },
  });

  // 用户手动输入时重置
  pi.on("input", async (event, _ctx) => {
    if (event.source !== "extension" && active) {
      continueCount = 0;
      lastErrorFingerprint = "";
      sameErrorCount = 0;
      clearSuppressTaskComplete();
    }
    return { action: "continue" as const };
  });

  // 抑制 task-notification
  pi.on("message_end", async (event, _ctx) => {
    if (!active) return;
    if (event.message.role !== "assistant") return;
    markSuppressTaskComplete();
  });

  // 核心循环
  pi.on("agent_settled", async (_event, ctx) => {
    // ── 未激活时：检测纯 <summary> XML，询问是否开启 goal ──
    if (!active) {
      if (!ctx.hasUI) return;
      const branch = ctx.sessionManager.getBranch();
      let lastEntryId = "";
      let lastText = "";
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === "message" && entry.message.role === "assistant") {
          lastEntryId = entry.id;
          lastText = extractText(entry.message);
          break;
        }
      }
      if (!lastEntryId || lastEntryId === lastPromptedEntryId) return;

      if (!PURE_SUMMARY_RE.test(lastText)) return;

      lastPromptedEntryId = lastEntryId;
      const goalDesc = extractGoalFromSummary(lastText);
      if (!goalDesc) return;

      const preview = goalDesc.length > 80 ? goalDesc.slice(0, 80) + "…" : goalDesc;
      const ok = await ctx.ui.confirm(
        "🎯 检测到任务计划",
        `模型输出了结构化的 <summary> 任务计划。\n\n待办：${preview}\n\n是否开启 Goal 自动续行模式？`,
      );
      if (!ok) return;

      activateGoal(ctx, goalDesc, "");
      // 立即续行第一轮
      continueCount++;
      updateWidget(ctx, goalDesc);
      scheduleContinue(buildContinuePrompt(goalDesc, goalDesc));
      return;
    }

    // 取最后一条 assistant 消息
    const branch = ctx.sessionManager.getBranch();
    let lastText = "";
    let lastStopReason: string | undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message.role === "assistant") {
        lastText = extractText(entry.message);
        lastStopReason = (entry.message as { stopReason?: string }).stopReason;
        break;
      }
    }

    // 用户手动中断（esc）→ 停止 goal，不再续行
    if (lastStopReason === "aborted") {
      const count = continueCount;
      resetState();
      ctx.ui.setStatus("goal", undefined);
      ctx.ui.setWidget("goal-status", undefined);
      ctx.ui.notify(`🎯 Goal 已停止：手动中断（共 ${count} 轮）`, "info");
      return;
    }

    // 1. XML 检测
    const summaryState = checkSummary(lastText);

    if (summaryState === "done") {
      // XML 说完成了 → 如果有 gate再验证一下
      if (gateCommand) {
        const gatePassed = await runGate(ctx);
        if (gatePassed) {
          finishGoal(ctx, goalDescription || "全部完成");
          return;
        }
        // gate 没过 → 继续（runGate 内部已处理续行）
        return;
      }
      finishGoal(ctx, goalDescription || "全部完成");
      return;
    }

    if (summaryState === "pending") {
      // XML 说还有活 → 续行
      continueCount++;
      const nextContent = extractNext(lastText);
      updateWidget(ctx, nextContent);
      maybeProgressNotify();
      scheduleContinue(buildContinuePrompt(goalDescription, nextContent));
      return;
    }

    // 2. 没有 XML → 看 gate
    if (gateCommand) {
      const gatePassed = await runGate(ctx);
      if (gatePassed) {
        finishGoal(ctx, goalDescription || `gate 通过: ${gateCommand}`);
        return;
      }
      // gate 没过 → runGate 内部已处理续行
      return;
    }

    // 3. 既没有 XML 也没有 gate → 直接续行
    continueCount++;
    updateWidget(ctx, "");
    maybeProgressNotify();
    scheduleContinue(buildContinuePrompt(goalDescription, ""));
  });

  // ── gate 执行 ──

  async function runGate(ctx: ExtensionContext): Promise<boolean> {
    ctx.ui.setStatus("goal", "🎯 验证中...");
    ctx.ui.setWidget("goal-status", [ctx.ui.theme.fg("accent", `🎯 运行: ${gateCommand}`)]);

    let result: { stdout: string; stderr: string; code: number | null };
    try {
      result = await pi.exec("bash", ["-c", gateCommand], { timeout: 120_000 });
    } catch (e: unknown) {
      result = { stdout: "", stderr: `执行异常: ${e instanceof Error ? e.message : String(e)}`, code: 1 };
    }

    if (result.code === 0) return true;

    // 失败处理
    continueCount++;
    const failureOutput = truncateOutput(
      [result.stdout, result.stderr].filter(Boolean).join("\n---stderr---\n"),
    );

    const fp = errorFingerprint(failureOutput);
    if (fp === lastErrorFingerprint) {
      sameErrorCount++;
    } else {
      sameErrorCount = 1;
      lastErrorFingerprint = fp;
    }

    if (sameErrorCount >= SAME_ERROR_THRESHOLD) {
      pauseGoal(
        ctx,
        `连续 ${SAME_ERROR_THRESHOLD} 次相同错误，需要人工介入`,
        [
          `⚠️ 验证命令 \`${gateCommand}\` 连续 ${SAME_ERROR_THRESHOLD} 次产生相同错误，自动暂停。`,
          "",
          "失败输出：",
          "```",
          failureOutput,
          "```",
          "",
          "请分析是否需要换一种方案，或告知我需要人工介入。",
        ].join("\n"),
      );
      return false;
    }

    ctx.ui.setStatus("goal", `🎯 ×${continueCount}`);
    ctx.ui.setWidget("goal-status", [
      ctx.ui.theme.fg("warning", `🎯 Gate 失败 ×${continueCount} (相同错误 ×${sameErrorCount})`),
      ctx.ui.theme.fg("dim", failureOutput.split("\n")[0]?.slice(0, 80) || ""),
    ]);

    maybeProgressNotify();
    scheduleContinue(buildGateFailPrompt(goalDescription, gateCommand, failureOutput));
    return false;
  }

  function updateWidget(ctx: ExtensionContext, nextContent: string) {
    ctx.ui.setStatus("goal", `🎯 ×${continueCount}`);
    ctx.ui.setWidget("goal-status", [
      ctx.ui.theme.fg("accent", `🎯 Goal 续行 ×${continueCount}`),
      ctx.ui.theme.fg("dim", nextContent ? nextContent.split("\n")[0] : goalDescription || "继续执行..."),
    ]);
  }

  // session 关闭时清理
  pi.on("session_shutdown", async () => {
    resetState();
  });
}
