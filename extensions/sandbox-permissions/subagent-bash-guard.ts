// subagent-bash-guard — 无 UI worker bash 防线
//
// 不弹 LLM/GUI 审批：硬拒绝直接返回；其余风险命令写 capability request，
// 然后在工具调用内阻塞等待父进程的响应文件（不 kill worker）。
// 批准就执行本条命令；拒绝就把理由作为工具结果返回给模型，agent 可以换方式继续。

import type { ExtensionAPI, BashSpawnContext, BashToolDetails } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { checkCommand } from "../../lib/sandbox-check.ts";
import {
  commandDigest,
  isWorkerApprovalCapability,
  isWorkerNetworkAutoApproved,
  makeCapabilityRequest,
  parseCapabilityGrants,
  requestedCapability,
  waitForCapabilityDecision,
  type CapabilityGrant,
} from "../../lib/subagent-capability.ts";

const PROMPT_SNIPPET = "Execute a bash command in the isolated worker sandbox. Risky commands block until the parent agent approves or denies them.";
const PROMPT_GUIDELINES = [
  "bash 在 worker 中经过文件系统沙箱；不要尝试读取凭据或绕过隔离。",
  "如果命令需要网络或其他额外能力，工具会阻塞等待主 agent 审批；被拒绝时按返回的理由换个安全写法继续，不要假装已经获批。",
] as const;

/** 原子写请求：tmp + rename，父进程读到的永远是完整 JSON（可覆盖上一轮残留） */
function writeRequest(path: string | undefined, request: unknown): boolean {
  if (!path) return false;
  try {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(request), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** 读一次响应文件：不存在 / 半截 JSON 都返回 undefined */
function readDecisionFile(path: string | undefined): unknown {
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT !== "1") return;

  const cwd = process.cwd();
  const shellPath = join(getAgentDir(), "scripts", "sandbox-shell.mjs");
  const requestPath = process.env.PI_SUBAGENT_CAPABILITY_REQUEST;
  const responsePath = process.env.PI_SUBAGENT_CAPABILITY_RESPONSE;
  const taskId = process.env.PI_TASK_ID;
  const initialParentPid = process.ppid;
  // 预批准（父进程显式传入的 grant）+ 本次进程内已批准的命令；同一 worker 里同一条命令只批一次
  const grants: CapabilityGrant[] = parseCapabilityGrants(process.env.PI_SUBAGENT_CAPABILITY_GRANTS);
  const granted = new Set(grants.map((g) => `${g.capability}:${g.commandDigest}`));
  const networkApproved = new Set<string>();

  const spawnHook = ({ command, cwd: commandCwd, env }: BashSpawnContext): BashSpawnContext => {
    const nextEnv = { ...env };
    // 批准登记后 spawnHook 才注入网络开关，保证只影响这一条命令。
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

      // 网络自动放行集合之外的 network 命令，以及命中安全规则的命令，都要父进程审批。
      // 同一条命令若同时命中两者，按 network 优先请求一次（父进程审的是整条命令）。
      const networkRisk = requested?.capability === "network" && !isWorkerNetworkAutoApproved(command);
      const commandRisk = !verdict.allow;
      if (networkRisk || commandRisk) {
        const digest = commandDigest(command);
        const capability = networkRisk ? "network" : "command";
        if (!granted.has(`${capability}:${digest}`)) {
          if (!responsePath) {
            return {
              content: [{ type: "text", text: "worker 缺少审批响应通道，命令未执行。" }],
              details: {} as BashToolDetails,
            };
          }
          const request = makeCapabilityRequest({
            capability,
            command,
            reason: networkRisk
              ? `worker 命令需要额外能力：${requested?.scope ?? "访问网络或远程包源"}`
              : (verdict.reason ?? "命令命中 worker 安全规则，需要主 agent 审批。"),
            cwd: ctx.cwd,
            taskId,
            scope: networkRisk ? (requested?.scope ?? "访问网络或远程包源") : "命令安全规则需要主 agent 审批",
          });
          if (!writeRequest(requestPath, request)) {
            return {
              content: [{ type: "text", text: "权限请求写入失败，命令未执行。" }],
              details: {} as BashToolDetails,
            };
          }
          // 在工具调用内阻塞等待：不 kill worker，保留上下文与进度
          const decision = await waitForCapabilityDecision(request.requestId, {
            readDecision: () => readDecisionFile(responsePath),
            parentAlive: () => process.ppid === initialParentPid && process.ppid !== 1,
          });
          try { unlinkSync(responsePath); } catch { /* 父进程可能已清理 */ }
          if (decision.action !== "allow") {
            const note = decision.comment || decision.review?.reason || "未获批准";
            return {
              content: [{ type: "text", text: `命令未获批准：${note}\n不要假装已获批；换一个不需要该能力的方式继续。` }],
              details: {} as BashToolDetails,
            };
          }
          granted.add(`${capability}:${digest}`);
        }
      }

      if (requested?.capability === "network") {
        // 自动放行与人工批准都只对当前精确命令生效；spawnHook 仅为本次进程注入网络开关。
        networkApproved.add(commandDigest(command));
      }
      return bashDef.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
