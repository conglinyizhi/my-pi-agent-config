// GUI 调用参考：lib/gui-runner.ts（Wails 统一启动器）
//
/**
 * 权限闸门扩展
 *
 * 在执行潜在危险的 bash 命令前请求确认。
 *
 * 审批流程：
 * 1. 安全白名单放行
 * 2. 自动拒绝规则直接拦（不弹窗）
 * 3. LLM 预审：需确认命令先过 LLM（verdict=safe 且 auto 模式 → 自动放行不弹窗；
 *    否则带 LLM 意见进入弹窗；审核失败回退弹窗，绝不静默放行）
 * 4. Wails GUI 审计面板（主要审批方式）
 * 5. GUI 不可用时回退到 TUI（含命中的规则详情与 LLM 意见）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { runGuiWindow, findGuiBinary } from "../../lib/gui-runner";
import { checkNotificationSupport, notifyQuestion } from "../../lib/notify-send";
import { auditCommand, extractTmpRedirectTargets, isTmpRedirectTargetSafe, type TokenRule } from "./rule-engine";
import { buildInlineScriptRejection, extractInlineScript, saveInlineScript } from "./inline-script";
import { createReviewCache, formatReviewNote, loadLlmReviewConfig, reviewCommand, type ReviewResult } from "./llm-review";
import { addAllowDir, addBlockDir, isWhitelisted, loadSandboxPaths } from "./paths";

/** 动态构造命令的合成规则（无危险规则命中但含动态构造时降级为人工确认） */
const DYNAMIC_RULE: TokenRule = {
  name: "dynamic-construct",
  tip: "命令含动态构造（命令替换/eval/变量作命令等），无法静态判断，请人工确认",
  autoReject: false,
};

/** 命令替换内部危险指令（剥洋葱审核捕获） */
const SUBST_DANGER_RULE: TokenRule = {
  name: "subst-danger",
  tip: "命令替换内部含危险指令，请人工确认",
  autoReject: false,
};

/** Python 代码段危险调用 */
const PY_DANGER_RULE: TokenRule = {
  name: "python-danger",
  tip: "Python 代码段含危险调用（os.system/rm/dd 等），请人工确认",
  autoReject: false,
};

/** 管道右侧执行器命令 */
const PIPE_EXEC_RULE: TokenRule = {
  name: "pipe-exec",
  tip: "管道右侧为执行器命令（sh/bash/python 等），可能执行任意代码，请人工确认",
  autoReject: false,
};

const GUI_TIMEOUT_MS = 3_600_000; // 1 小时兜底（仅防窗口进程卡死；窗口内不再自动超时，用户可任意时长审批）

/** pnpm 可用性（带缓存；startup 检测一次，tool_call 复用） */
let pnpmChecked = false;
let pnpmAvailable = false;

/** LLM 预审内存缓存（同命令同规则不重复调 API） */
const reviewCache = createReviewCache();

/** 检测 pnpm 是否可用：spawnSync 跑 pnpm --version，ENOENT 视为未安装 */
function detectPnpm(): boolean {
  if (pnpmChecked) return pnpmAvailable;
  pnpmChecked = true;
  try {
    const r = spawnSync("pnpm", ["--version"], { stdio: "ignore" });
    pnpmAvailable = r.status === 0;
  } catch {
    pnpmAvailable = false;
  }
  return pnpmAvailable;
}

/** pnpm 未安装时的安装指导（供拦截 reason 与 startup 通知共用） */
const PNPM_INSTALL_HINT = "pnpm 未安装，请先要求用户安装 pnpm（npm install -g pnpm 或 curl -fsSL https://get.pnpm.io/install.sh | sh -），安装完成后再继续项目";

/** 通过 GUI 审批（Wails 版，替代 Electron） */
async function tryGuiApproval(
  command: string,
  rules: TokenRule[],
  signal: AbortSignal | undefined,
  review?: ReviewResult,
): Promise<
  | {
      action: "allow" | "deny" | "reject-all";
      comment?: string;
      flagged?: number[];
      /** 用户在 GUI 上点选的目录白/黑名单操作 */
      pathActions?: { path: string; list: "allow" | "block" }[];
    }
  | "gui-unavailable"
> {
  if (!findGuiBinary()) return "gui-unavailable";

  const result = await runGuiWindow("gate", {
    command,
    taskId: process.env.PI_TASK_ID || null,
    rules: rules.map(r => ({
      name: r.name,
      tip: r.tip,
      autoReject: r.autoReject || false,
      matched: r.matched ?? [],
    })),
    // 云端模型审核意见：verdict/reason/suggestion/opinion，GUI 完整展示供用户判断
    review: review ?? null,
    // 目录白名单归属升权申请窗口（allow.ts 传 candidatePaths）；审计窗口专注命令与审核意见
  }, { timeoutMs: GUI_TIMEOUT_MS, signal });

  // 仅采纳用户明确的选择（允许/拒绝）；窗口异常关闭或未选择 → 视为 GUI 不可用，回退 TUI
  if (result.ok && result.data && (result.data.action === "allow" || result.data.action === "deny" || result.data.action === "reject-all")) {
    return result.data;
  }
  return "gui-unavailable";
}

/** 生成规则的 TUI 展示文本 */
function formatRulesForTui(rules: TokenRule[]): string {
  if (rules.length === 0) return "";
  const lines = rules.map(r =>
    `  · ${r.autoReject ? "[自动拒绝] " : ""}${r.name}${r.matched?.length ? ` (${r.matched.join(" ")})` : ""} → ${r.tip}`
  );
  return `\n命中规则：\n${lines.join("\n")}`;
}

/** 构建给大模型的拒绝原因：带命令、命中规则与用户标记/理由，避免只有一句裸评论让模型猜上下文 */
function buildRejectReason(
  command: string,
  rules: TokenRule[],
  comment?: string,
  prefix = "已阻止",
  flagged?: number[],
): string {
  const preview = command.length > 160 ? command.slice(0, 160) + "…" : command;
  const ruleNames = rules.map(r => r.name).join("、");
  // flagged 是用户勾选的规则索引（GateView 对话框），映射回规则名；越界/缺失防御性跳过
  const flaggedNames = flagged?.length
    ? flagged.map(i => rules[i]?.name).filter(Boolean).join("、")
    : "";
  const cleanComment = comment?.replace(/\s+/g, " ").trim();
  const parts = [`命令：${preview}`];
  if (ruleNames) parts.push(`命中规则：${ruleNames}`);
  if (flaggedNames) parts.push(`用户标记：${flaggedNames}`);
  if (cleanComment) parts.push(`用户理由：${cleanComment}`);
  return `${prefix}（${parts.join("；")}）`;
}

export default async function (pi: ExtensionAPI) {
  const support = await checkNotificationSupport();
  const notificationReady = support.supported;

  // startup 检测 pnpm：未安装时 TUI 通知用户（npm/npx 拦截 reason 也会附带安装指导）
  pi.on("session_start", (_event, ctx) => {
    if (!detectPnpm() && ctx.hasUI) {
      ctx.ui.notify(`⚠️ ${PNPM_INSTALL_HINT}`, "warning");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command: string = event.input.command as string;

    // Preserve a common model shortcut without executing it. Extraction is
    // intentionally strict: anything more complex follows the normal audit path.
    const inlineScript = extractInlineScript(command);
    if (inlineScript) {
      try {
        const saved = saveInlineScript(inlineScript);
        return { block: true, reason: buildInlineScriptRejection(saved) };
      } catch (error) {
        return {
          block: true,
          reason: `安全闸门拒绝了内联 ${inlineScript.runtime === "python" ? "Python" : "Node.js"} 代码，且无法安全保存脚本：${(error as Error).message}`,
        };
      }
    }

    // 分级审核：mask 盲区 → 剥洋葱内部审核 → Python 段检测 → 管道执行器 → 规则判定
    const audit = auditCommand(command);
    const { allow, safe, rules, dynamic, dynamicTokens, dangerous, pyDanger, pipeExec } = audit;

    // /tmp 重定向目标动态校验：软链指向 /tmp 之外（如系统文件）视为危险，静态前缀豁免不覆盖
    const tmpEscape = extractTmpRedirectTargets(command).filter((t) => !isTmpRedirectTargetSafe(t));

    // 完全安全 → 放行
    if (allow && tmpEscape.length === 0) {
      return undefined;
    }
    if (tmpEscape.length > 0) {
      rules.push({ name: "write-redirect-symlink", tip: "重定向目标符号链接指向 /tmp 之外（可能覆盖系统文件），请确认目标路径", matched: [...tmpEscape] });
    }

    // 危险信号各自成规则（matched 带原文供 GUI 高亮），
    // 不合并成一条：多类危险同时命中时，理由/高亮/勾选要能逐条对应
    if (dynamic) rules.push({ ...DYNAMIC_RULE, matched: [...dynamicTokens] });
    if (dangerous.length > 0) rules.push({ ...SUBST_DANGER_RULE, matched: [...dangerous] });
    if (pyDanger.length > 0) rules.push({ ...PY_DANGER_RULE, matched: [...pyDanger] });
    if (pipeExec.length > 0) rules.push({ ...PIPE_EXEC_RULE, matched: [...pipeExec] });

    // 未被白名单覆盖且全部命中规则都是 autoReject → 直接拦（白名单覆盖时降级确认而非静默拦）
    if (!safe && rules.every(r => r.autoReject)) {
      const tipText = rules.map(r => r.tip).join("；");
      // npm/npx 被拦且 pnpm 缺失：reason 明确指导模型先要求用户安装 pnpm
      const pnpmHint = rules.some(r => r.name === "npm-pnpm") && !detectPnpm()
        ? `；${PNPM_INSTALL_HINT}`
        : "";
      return { block: true, reason: `自动拒绝：${tipText}${pnpmHint}` };
    }

    // 目录白名单豁免：命令所有目标路径都在 allow_dirs 内 → 直接放行（不弹窗、不过 LLM 预审）
    // 保守：autoReject 硬拦优先（白名单不豁免）；动态构造/变量引用/无路径 → 不豁免
    const { allowDirs } = loadSandboxPaths();
    if (isWhitelisted(command, allowDirs)) {
      pi.appendEntry("sandbox-paths", { command, action: "allow-whitelist", dirs: allowDirs, ts: Date.now() });
      return undefined;
    }

    // 无 UI 则直接阻止
    if (!ctx.hasUI) {
      const tipText = rules.map(r => `${r.name}: ${r.tip}`).join("；");
      return { block: true, reason: tipText ? `危险命令已阻止：${tipText}` : "危险命令已阻止" };
    }

    // ====== LLM 预审层：需确认命令先过 LLM；safe 且 auto 模式自动放行，减少弹窗 ======
    let reviewNote = "";
    // LLM 预审结论：随 GUI 窗口一并传给用户查看（verdict/reason/suggestion/opinion）
    let review: ReviewResult | undefined;
    const reviewConfig = loadLlmReviewConfig();
    if (reviewConfig.enabled) {
      review = await reviewCommand(pi, ctx, command, rules, ctx.signal, reviewCache, reviewConfig);
      if (review.verdict === "safe" && reviewConfig.mode === "auto") {
        pi.appendEntry("sandbox-llm-review", {
          command,
          verdict: review.verdict,
          reason: review.reason,
          mode: "auto-allow",
          ts: Date.now(),
        });
        return undefined;
      }
      // 有有效结论，或模型返回了可展示的文本（opinion）——即使是 error 也一并展示，供人工判断
      if (review.verdict !== "error" || review.opinion) {
        pi.appendEntry("sandbox-llm-review", {
          command,
          verdict: review.verdict,
          reason: review.reason,
          opinion: review.opinion,
          ts: Date.now(),
        });
        reviewNote = `\n\n${formatReviewNote(review)}`;
      }
      // 审核失败（限流/超时/无模型）：不静默吞掉，失败原因随 GUI 一并展示，用户知道云端审核为何没出意见
    }

    // 桌面通知
    if (notificationReady) {
      notifyQuestion(
        `危险命令请求确认：${command.slice(0, 80)}${command.length > 80 ? "..." : ""}${reviewNote ? `\n${reviewNote}` : ""}`
      ).catch(() => {});
    }

    // ====== 审批流程 ======

    // 1. 尝试 Wails GUI（带云端模型审核意见，窗口内完整展示）
    const guiResult = await tryGuiApproval(command, rules, ctx.signal, review);

    if (guiResult === "gui-unavailable") { /* fall through to TUI */ }
    else {
      // 用户在 GUI 上点选的目录白/黑名单操作（无论最终 allow/deny 都先落名单）
      for (const pa of guiResult.pathActions ?? []) {
        if (pa?.list === "allow" && typeof pa.path === "string") addAllowDir(pa.path);
        else if (pa?.list === "block" && typeof pa.path === "string") addBlockDir(pa.path);
      }
      if (guiResult.action === "allow") return undefined;
      if (guiResult.action === "deny" || guiResult.action === "reject-all") {
        // 保存审核意见
        if (guiResult.comment) {
          try {
            const reasonsFile = path.join(os.homedir(), ".pi", "agent", "permission-gate-reasons.json");
            const reasons: string[] = fs.existsSync(reasonsFile)
              ? JSON.parse(fs.readFileSync(reasonsFile, "utf-8"))
              : [];
            reasons.unshift(guiResult.comment);
            if (reasons.length > 20) reasons.length = 20;
            fs.mkdirSync(path.dirname(reasonsFile), { recursive: true });
            fs.writeFileSync(reasonsFile, JSON.stringify(reasons, null, 2));
          } catch {}
        }
        const reason = buildRejectReason(command, rules, guiResult.comment, "GUI 审批拒绝", guiResult.flagged);
        return { block: true, reason };
      }
    }

    // 2. GUI 不可用 → TUI 回退
    const commandPreview = command.length > 120
      ? command.slice(0, 120) + "..."
      : command;
    const ruleInfo = formatRulesForTui(rules);

    const choice = await ctx.ui.select(
      `⚠️ 危险命令：\n\n  ${commandPreview}\n${ruleInfo}\n\n如何操作？`,
      ["🖥 重新打开 GUI", "✅ 允许执行", "❌ 拒绝"]
    );

    if (choice?.includes("GUI")) {
      // 递归重试 GUI（注意：tryGuiApproval 的 allow 是对象 { action: "allow" }，不是字符串）
      const retry = await tryGuiApproval(command, rules, ctx.signal, review);
      if (retry !== "gui-unavailable" && retry.action === "allow") return undefined;
      if (retry === "gui-unavailable") {
        // GUI 再次未响应：回 TUI 兜底，不再递归，别把「窗口没打开」伪装成「用户拒绝」
        const retryChoice = await ctx.ui.select(
          `⚠️ GUI 未返回结果，命令仍待确认：\n\n  ${commandPreview}\n${ruleInfo}\n\n如何操作？`,
          ["✅ 允许执行", "❌ 拒绝"]
        );
        if (retryChoice?.includes("允许")) return undefined;
        return { block: true, reason: buildRejectReason(command, rules, undefined, "已被用户阻止") };
      }
      return { block: true, reason: buildRejectReason(command, rules, retry.comment, "GUI 审批拒绝", retry.flagged) };
    }

    if (choice?.includes("允许")) return undefined;
    return { block: true, reason: buildRejectReason(command, rules, undefined, "已被用户阻止") };
  });
}
