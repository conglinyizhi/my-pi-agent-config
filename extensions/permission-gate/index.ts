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
 * 3. Wails GUI 审计面板（主要审批方式）
 * 4. GUI 不可用时回退到 TUI（含命中的规则详情）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runGuiWindow, findGuiBinary } from "../../lib/gui-runner";
import { checkNotificationSupport, notifyQuestion } from "../../lib/notify-send";
import { isCommandSafe, getMatchedRules, isAutoReject, type MatchedRule } from "./helpers";

const GUI_TIMEOUT_MS = 120_000; // 2 分钟

/** 通过 GUI 审批（Wails 版，替代 Electron） */
async function tryGuiApproval(
  command: string,
  rules: MatchedRule[],
  signal: AbortSignal | undefined,
): Promise<{ action: "allow" | "deny" | "reject-all"; comment?: string } | "gui-unavailable"> {
  if (!findGuiBinary()) return "gui-unavailable";

  const result = await runGuiWindow("gate", {
    command,
    taskId: process.env.PI_TASK_ID || null,
    rules: rules.map(r => ({
      pattern: r.pattern,
      tip: r.tip,
      autoReject: r.autoReject || false,
    })),
  }, { timeoutMs: GUI_TIMEOUT_MS, signal });

  // 仅采纳用户明确的选择（允许/拒绝）；窗口异常关闭或未选择 → 视为 GUI 不可用，回退 TUI
  if (result.ok && result.data && (result.data.action === "allow" || result.data.action === "deny" || result.data.action === "reject-all")) {
    return result.data;
  }
  return "gui-unavailable";
}

/** 生成规则的 TUI 展示文本 */
function formatRulesForTui(rules: MatchedRule[]): string {
  if (rules.length === 0) return "";
  const lines = rules.map(r =>
    `  · ${r.autoReject ? "[自动拒绝] " : ""}${r.pattern} → ${r.tip}`
  );
  return `\n命中规则：\n${lines.join("\n")}`;
}

export default async function (pi: ExtensionAPI) {
  const support = await checkNotificationSupport();
  const notificationReady = support.supported;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command: string = event.input.command as string;

    // 安全模式白名单放行
    if (isCommandSafe(command)) return undefined;

    // 获取匹配的规则
    const rules = getMatchedRules(command);

    // 全部命中规则都是 autoReject → 直接拦
    if (rules.length > 0 && rules.every(r => r.autoReject)) {
      const tipText = rules.map(r => r.tip).join("；");
      return { block: true, reason: `自动拒绝：${tipText}` };
    }

    // 无 UI 则直接阻止
    if (!ctx.hasUI) {
      const tipText = rules.map(r => `${r.pattern}: ${r.tip}`).join("；");
      return { block: true, reason: tipText ? `危险命令已阻止：${tipText}` : "危险命令已阻止" };
    }

    // 桌面通知
    if (notificationReady) {
      notifyQuestion(
        `危险命令请求确认：${command.slice(0, 80)}${command.length > 80 ? "..." : ""}`
      ).catch(() => {});
    }

    // ====== 审批流程 ======

    // 1. 尝试 Wails GUI
    const guiResult = await tryGuiApproval(command, rules, ctx.signal);

    if (guiResult === "gui-unavailable") { /* fall through to TUI */ }
    else if (guiResult.action === "allow") return undefined;
    else if (guiResult.action === "deny" || guiResult.action === "reject-all") {
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
      const reason = guiResult.comment
        ? `GUI 审批拒绝：${guiResult.comment}`
        : "GUI 审批拒绝";
      return { block: true, reason };
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
      // 递归重试 GUI
      const retry = await tryGuiApproval(command, rules, ctx.signal);
      if (retry === "allow") return undefined;
      return { block: true, reason: "GUI 审批拒绝" };
    }

    if (choice?.includes("允许")) return undefined;
    return { block: true, reason: "已被用户阻止" };
  });
}
