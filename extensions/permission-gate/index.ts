/**
 * 权限闸门扩展
 *
 * 在执行潜在危险的 bash 命令前请求确认。
 *
 * 审批流程：
 * 1. 安全白名单放行
 * 2. 自动拒绝规则直接拦（不弹窗）
 * 3. Electron GUI 审计面板（主要审批方式）
 * 4. GUI 不可用时回退到 TUI（含命中的规则详情）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { checkNotificationSupport, notifyQuestion } from "../../lib/notify-send";
import { isCommandSafe, getMatchedRules, isAutoReject, type MatchedRule } from "./helpers";

const GUI_TIMEOUT_MS = 120_000; // 2 分钟

/** 查找可用的 electron 二进制 */
function findElectron(): string | null {
  try {
    const bins = execSync("ls /usr/bin/electron* 2>/dev/null", { encoding: "utf-8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort()
      .reverse(); // 最新优先
    return bins[0] || null;
  } catch {
    return null;
  }
}

/** 通过 Electron GUI 审批 */
async function tryGuiApproval(
  command: string,
  rules: MatchedRule[],
  signal: AbortSignal | undefined,
): Promise<"allow" | "deny" | "reject-all" | "gui-unavailable"> {
  const electronBin = findElectron();
  if (!electronBin) return "gui-unavailable";

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gate-"));
  const requestFile = path.join(tmpDir, "request.json");
  const responseFile = path.join(tmpDir, "response.json");
  const appJs = path.join(__dirname, "gui", "app.js");

  if (!fs.existsSync(appJs)) {
    fs.rmSync(tmpDir, { recursive: true });
    return "gui-unavailable";
  }

  // 写请求
  fs.writeFileSync(requestFile, JSON.stringify({
    command,
    rules: rules.map(r => ({
      pattern: r.pattern,
      tip: r.tip,
      autoReject: r.autoReject || false,
    })),
  }));

  try {
    const proc = spawn(electronBin, [appJs, requestFile, responseFile], {
      stdio: "ignore",
      detached: true,
    });

    // 等待响应文件出现
    const result = await new Promise<"allow" | "deny" | "reject-all" | "gui-unavailable">((resolve) => {
      const timeout = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch {}
        resolve("gui-unavailable");
      }, GUI_TIMEOUT_MS);

      const check = setInterval(() => {
        try {
          const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
          clearTimeout(timeout);
          clearInterval(check);
          resolve(data.action === "allow" ? "allow" :
                   data.action === "deny" ? "deny" :
                   data.action === "reject-all" ? "reject-all" : "deny");
        } catch {
          // response 还没写完，继续等
        }
      }, 300);

      proc.on("close", () => {
        setTimeout(() => {
          try {
            const data = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
            clearTimeout(timeout);
            clearInterval(check);
            resolve(data.action);
          } catch {
            clearTimeout(timeout);
            clearInterval(check);
            resolve("deny"); // 关了窗口没点按钮 = 拒绝
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

    // 1. 尝试 Electron GUI
    const guiResult = await tryGuiApproval(command, rules, ctx.signal);

    if (guiResult === "allow") return undefined; // 放行
    if (guiResult === "deny") return { block: true, reason: "GUI 审批拒绝" };
    if (guiResult === "reject-all") {
      // TODO: 记住本次 session 拒绝同类命令
      return { block: true, reason: "GUI 审批全部拒绝" };
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
