// trident-translator — 将自然语言发言转为结构化任务描述
//
// 用 translator 角色模型做一次无工具 LLM 调用，解析 --mode json 事件流后
// 只返回最终文本。不复用 coding-agent 工具链。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getFinalOutput } from "../../lib/message-utils";

type PiInvocation = { command: string; args: string[] };

function parseRolesToml(content: string): Record<string, string> {
  const roles: Record<string, string> = {};
  let inRoles = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "[roles]") {
      inRoles = true;
      continue;
    }
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

function getTranslatorModel(): string {
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
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

/** 从 --mode json 的 NDJSON 事件流中收集 message，并抽出最终 assistant 文本 */
function extractFinalText(stdout: string): string {
  const messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "message_end" && event.message?.role) {
      messages.push(event.message as { role: string; content: string | Array<{ type: string; text?: string }> });
    }
  }

  const fromMessages = getFinalOutput(messages);
  if (fromMessages) return fromMessages.trim();

  // 兜底：agent_end.messages
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { type?: string; messages?: Array<{ role: string; content: unknown }> };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      const text = getFinalOutput(
        event.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>,
      );
      if (text) return text.trim();
    }
  }

  return "";
}

function looksStructured(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (/\*\*title\*\*|^\s*title\s*:/im.test(text) || lower.includes("**title**")) &&
    (/\*\*goal\*\*|^\s*goal\s*:/im.test(text) || lower.includes("**goal**"))
  );
}

const TRANSLATOR_SYSTEM_PROMPT = `你是翻译器。将用户的原始发言转化为结构化任务描述。
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

function callPiTranslate(
  model: string,
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal | undefined,
): Promise<{ text: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    // --system-prompt 吃的是文本，不是文件路径；勿传 path
    // 无工具、无扩展、无技能、无上下文文件，避免问候语/SYSTEM 污染翻译结果
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

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

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
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export default function (pi: ExtensionAPI) {
  // 子进程内不再注册，避免递归
  if (process.env.PI_SUBAGENT) return;

  pi.registerTool({
    name: "translate_task",
    label: "Translate Task",
    description:
      "将用户的自然语言发言转为结构化任务描述。使用 translator 角色指定的模型（建议与主 agent 不同厂商），做信号检测与意图提取。",
    promptSnippet: "Translate a user utterance into a structured task description",
    promptGuidelines: [
      "Use translate_task when the user describes a task that needs to be captured and tracked. Pass the user's raw utterance as input.",
      "After translate_task returns, present the structured description for confirmation, then task_create if confirmed.",
    ],
    parameters: Type.Object({
      utterance: Type.String({
        description: "用户的原始发言（保持原文，不修改）",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const translatorModel = getTranslatorModel();
      if (!translatorModel) {
        return {
          content: [
            {
              type: "text" as const,
              text: "错误：未配置 translator 模型。请在 ~/.pi/agent/providers.roles.toml 的 [roles] 中设置 translator。",
            },
          ],
          details: { error: "no_translator_model" },
        };
      }

      try {
        const { text, stderr, exitCode } = await callPiTranslate(
          translatorModel,
          TRANSLATOR_SYSTEM_PROMPT,
          params.utterance,
          signal,
        );

        if (exitCode !== 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `翻译失败：pi 退出码 ${exitCode}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`,
              },
            ],
            details: { error: "pi_exit", exitCode, stderr: stderr.slice(0, 2000), model: translatorModel },
          };
        }

        if (!text) {
          return {
            content: [
              {
                type: "text" as const,
                text: "翻译失败：未从模型输出中解析到最终文本。",
              },
            ],
            details: { error: "empty_output", model: translatorModel },
          };
        }

        if (!looksStructured(text)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `翻译结果未符合约定格式（缺 title/goal）。原始输出：\n\n${text}`,
              },
            ],
            details: { error: "unstructured", model: translatorModel, raw: text },
          };
        }

        return {
          content: [{ type: "text" as const, text }],
          details: { model: translatorModel },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `翻译失败：${message}` }],
          details: { error: message },
        };
      }
    },
  });
}
