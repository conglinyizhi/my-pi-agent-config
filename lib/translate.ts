// translate.ts — 翻译核心：将自然语言发言转为结构化任务描述
//
// 提取自 extensions/trident-translator，供 task_new 内部调用。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getFinalOutput } from "./message-utils";

type PiInvocation = { command: string; args: string[] };

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

export function getTranslatorModel(): string {
  const configPath = path.join(os.homedir(), ".pi", "agent", "providers.roles.toml");
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const roles = parseRolesToml(content);
    return roles.translator || "";
  } catch {
    return "";
  }
}

function getPiInvocation(args: string[]): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

function extractFinalText(stdout: string): string {
  const messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { type?: string; message?: { role?: string; content?: unknown } };
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === "message_end" && event.message?.role) {
      messages.push(event.message as { role: string; content: string | Array<{ type: string; text?: string }> });
    }
  }
  const fromMessages = getFinalOutput(messages);
  if (fromMessages) return fromMessages.trim();
  // 兜底
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { type?: string; messages?: Array<{ role: string; content: unknown }> };
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      const text = getFinalOutput(event.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>);
      if (text) return text.trim();
    }
  }
  return "";
}

export function looksStructured(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (/\*\*title\*\*|^\s*title\s*:/im.test(text) || lower.includes("**title**")) &&
    (/\*\*goal\*\*|^\s*goal\s*:/im.test(text) || lower.includes("**goal**"))
  );
}

export const TRANSLATOR_SYSTEM_PROMPT = `你是翻译器。将用户的原始发言转化为结构化任务描述。
不要使用任何工具。不要提问。不要读文件。不要解释过程。
只输出下面格式（字段名保持英文加粗）：

**title**: [简洁的任务标题]
**goal**: [一句话描述目标]
**constraints**:
- [约束；未知则写「未说明」]
**user_signals**: [用户状态信号；未知则写「未识别」]
**context**: [原始发言全文，一字不改]

## 规则
1. 信号检测可选：过载/已知/拒绝/深问/低动力/高投入/焦躁/求确认；吃不准就写「未识别」
2. 意图只从用户原话提取，不脑补未说的技术栈或路径
3. 隐私剥离：私人角色名、个人经历、不宜公开内容用中性措辞替换；**context 仍尽量保留原话**，只在明显敏感时脱敏
`;

export interface TranslateResult {
  text: string;
  stderr: string;
  exitCode: number;
}

export function callPiTranslate(
  model: string,
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal | undefined,
): Promise<TranslateResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "--mode", "json",
      "-p",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--thinking", "off",
      "--model", model,
      "--system-prompt", systemPrompt,
      userMessage,
    ];

    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_SUBAGENT: "1" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ text: extractFinalText(stdout), stderr, exitCode: code ?? 0 });
    });

    proc.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    if (signal) {
      const onAbort = () => {
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
