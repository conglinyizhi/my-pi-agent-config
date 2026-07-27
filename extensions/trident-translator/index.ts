import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readFile } from "node:fs/promises";

/**
 * 解析简单的 TOML roles 节。
 * 不做完整 TOML 解析——providers.roles.toml 格式固定。
 */
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

/**
 * 读取 translator 模型配置。
 */
async function getTranslatorModel(): Promise<string> {
  const configPath = path.join(os.homedir(), ".pi", "agent", "providers.roles.toml");
  try {
    const content = await readFile(configPath, "utf-8");
    const roles = parseRolesToml(content);
    return roles.translator || "";
  } catch {
    return "";
  }
}

/**
 * 获取 pi 进程启动参数。
 * 复用 subagent 扩展的逻辑。
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

/**
 * 调用 pi 子进程做一次 LLM 翻译。
 */
function callPiTranslate(
  model: string,
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "--mode", "json",
      "-p",
      "--no-session",
      "--model", model,
      "--system-prompt", systemPrompt,
    ];

    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_SUBAGENT: "1" },
    });

    let stdout = "";
    let stderr = "";

    // 写入 user message
    proc.stdin?.write(userMessage);
    proc.stdin?.end();

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number) => {
      if (code !== 0) {
        reject(new Error(`pi exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });

    proc.on("error", (err: Error) => {
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

const TRANSLATOR_SYSTEM_PROMPT = `你是翻译器。将用户的原始发言转化为结构化任务描述。

## 工作流程
1. 信号检测：分析用户当前状态（过载/已知/拒绝/深问/低动力/高投入/焦躁/求确认）
2. 意图提取：从发言中提取核心任务目标
3. 约束收集：识别技术栈、环境限制、硬约束
4. 结构化输出

## 输出格式
直接用以下格式输出，不要额外解释：

**title**: [简洁的任务标题]
**goal**: [一句话描述目标]
**constraints**: 
- [约束1]
- [约束2]
**user_signals**: [用户状态信号]
**context**: [原始发言全文]

## 隐私剥离
不得输出用户对话中的私人语境——角色名、个人经历详情、不宜公开的内容。用中性措辞替换。`;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "translate_task",
    label: "Translate Task",
    description: `将用户的自然语言发言转为结构化任务描述。使用 translator 角色指定的模型（与主agent不同厂商），应用信号检测和意图提取。`,
    promptSnippet: "Translate a user utterance into a structured task description",
    promptGuidelines: [
      "Use translate_task when the user describes a task that needs to be captured and tracked. Pass the user's raw utterance as input.",
    ],
    parameters: Type.Object({
      utterance: Type.String({
        description: "用户的原始发言（保持原文，不修改）",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const translatorModel = await getTranslatorModel();
      if (!translatorModel) {
        return {
          content: [{
            type: "text",
            text: "错误：未配置 translator 模型。请创建 ~/.pi/agent/providers.roles.toml 并设置 [roles] translator 字段。",
          }],
          details: { error: "no_translator_model" },
        };
      }

      try {
        const result = await callPiTranslate(
          translatorModel,
          TRANSLATOR_SYSTEM_PROMPT,
          params.utterance,
          signal,
        );

        return {
          content: [{ type: "text", text: result }],
          details: { model: translatorModel },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: `翻译失败：${message}`,
          }],
          details: { error: message },
        };
      }
    },
  });
}
