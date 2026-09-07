// subagent-bash-guard — 无 UI worker bash 防线
//
// 不弹 LLM/GU I 审批：硬拒绝直接返回；其余风险命令写 capability request，
// 由父进程发现后终止 worker，并把请求交给主对话审批。

import type { ExtensionAPI, BashSpawnContext, BashToolDetails } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { checkCommand } from "../../lib/sandbox-check.ts";
import {
  commandDigest,
  consumeMatchingGrant,
  hasMatchingGrant,
  isWorkerApprovalCapability,
  isWorkerNetworkAutoApproved,
  makeCapabilityRequest,
  parseCapabilityGrants,
  requestedCapability,
  type CapabilityGrant,
} from "../../lib/subagent-capability.ts";

const PROMPT_SNIPPET = "Execute a bash command in the isolated worker sandbox. Risky commands may stop the worker and request approval from the parent agent.";
const PROMPT_GUIDELINES = [
  "bash 在 worker 中经过文件系统沙箱；不要尝试读取凭据或绕过隔离。",
  "如果命令需要网络或其他额外能力，worker 会停止并把权限请求交给主 agent，不要假装已经获批。",
] as const;

function writeRequest(path: string | undefined, request: unknown): void {
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(request), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    // 父进程同时监控子进程输出；写失败时仍返回阻断文本，不放行。
  }
}

export default function (pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT !== "1") return;

  const cwd = process.cwd();
  const shellPath = join(getAgentDir(), "scripts", "sandbox-shell.mjs");
  const requestPath = process.env.PI_SUBAGENT_CAPABILITY_REQUEST;
  const grants: CapabilityGrant[] = parseCapabilityGrants(process.env.PI_SUBAGENT_CAPABILITY_GRANTS);
  const taskId = process.env.PI_TASK_ID;
  const networkApproved = new Set<string>();

  const spawnHook = ({ command, cwd: commandCwd, env }: BashSpawnContext): BashSpawnContext => {
    const nextEnv = { ...env };
    // execute 已消费精确 grant 后才登记；spawnHook 再消费登记，保证只影响这一条命令。
    if (networkApproved.delete(commandDigest(command))) nextEnv.PI_SANDBOX_NETWORK_ALLOW = "1";
    else delete nextEnv.PI_SANDBOX_NETWORK_ALLOW;
    return { command, cwd: commandCwd, env: nextEnv };
  };

  const bashDef = createBashToolDefinition(cwd, {
    shellPath,
    spawnHook,
  });

  pi.registerTool({
    ...bashDef,
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: [...PROMPT_GUIDELINES],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const command = typeof params.command === "string" ? params.command : "";
      const verdict = checkCommand(command, { cwd: ctx.cwd });

      const requested = requestedCapability(command);
      const hardReject = !verdict.allow && (!verdict.rules || verdict.rules.length === 0 || verdict.rules.every((rule) => rule.autoReject));
      if (hardReject) {
        return {
          content: [{ type: "text", text: verdict.reason ?? "已由 worker 沙箱拒绝。" }],
          details: {} as BashToolDetails,
        };
      }

      if (requested && !isWorkerApprovalCapability(requested.capability)) {
        return {
          content: [{ type: "text", text: `worker 沙箱拒绝 ${requested.capability} 能力：该能力不开放给 subagent。` }],
          details: {} as BashToolDetails,
        };
      }

      // 一条命令可能同时需要 network 与 command 两把钥匙（例如 curl | sh）。
      // 这里只检查，不提前消费；所有必需 grant 齐全后才在执行前一次性消费。
      // 明确列出的工作区开发期拉取命令不再上报父级弹窗；仍受 Landlock、
      // 精确命令解析和下方 command 风险检查约束。其余网络请求保持一次性 grant 流程。
      const networkAutoApproved = requested?.capability === "network" && isWorkerNetworkAutoApproved(command);
      const networkGranted = requested?.capability === "network"
        ? networkAutoApproved || hasMatchingGrant(command, "network", grants)
        : false;
      const commandRisk = !verdict.allow;
      const commandGranted = commandRisk ? hasMatchingGrant(command, "command", grants) : true;
      if (requested?.capability === "network" && !networkGranted) {
        const request = makeCapabilityRequest({
          capability: "network",
          command,
          reason: `worker 命令需要额外能力：${requested.scope}`,
          cwd: ctx.cwd,
          taskId,
          scope: requested.scope,
        });
        writeRequest(requestPath, request);
        return {
          content: [{ type: "text", text: `WORKER_NEEDS_APPROVAL ${request.requestId}\n${request.capability}: ${request.scope}\n命令已阻断，等待主 agent 处理权限请求。` }],
          details: {} as BashToolDetails,
        };
      }
      if (commandRisk && !commandGranted) {
        const request = makeCapabilityRequest({
          capability: "command",
          command,
          reason: verdict.reason ?? "命令命中 worker 安全规则，需要主 agent 审批。",
          cwd: ctx.cwd,
          taskId,
          scope: "命令安全规则需要主 agent 审批",
        });
        writeRequest(requestPath, request);
        return {
          content: [{ type: "text", text: `WORKER_NEEDS_APPROVAL ${request.requestId}\n${request.capability}: ${request.scope}\n命令已阻断，等待主 agent 处理权限请求。` }],
          details: {} as BashToolDetails,
        };
      }

      if (requested?.capability === "network") {
        // 自动审核与人工 grant 都只对当前精确 command 生效；spawnHook 仅为本次
        // 进程注入网络开关，后续命令必须重新经过审核。
        if (!networkAutoApproved) consumeMatchingGrant(command, "network", grants);
        networkApproved.add(commandDigest(command));
      }
      if (commandRisk) consumeMatchingGrant(command, "command", grants);
      return bashDef.execute(toolCallId, params, signal, onUpdate, ctx);

    },
  });
}
