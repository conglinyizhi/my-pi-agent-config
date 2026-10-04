// subagent-bash-guard — 无 UI worker bash 防线
//
// 不弹 LLM/GUI 审批：硬拒绝直接返回；其余风险命令写 capability request，
// 然后在工具调用内阻塞等待父进程的响应文件（不 kill worker）。
// 批准就执行本条命令；拒绝就把理由作为工具结果返回给模型，agent 可以换方式继续。

import type { ExtensionAPI, BashToolDetails } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { checkCommand } from "../../lib/sandbox-check.ts";
import { findForeignPackageManager, foreignPackageManagerMessage } from "../../lib/package-manager-guard.ts";
import { DEFAULT_BASH_TIMEOUT_SECONDS, withDefaultTimeout, withTimeoutDoc } from "../../lib/bash-timeout.ts";
import {
  commandDigest,
  isWorkerApprovalCapability,
  makeCapabilityRequest,
  parseCapabilityGrants,
  readCapabilityDecisionFile,
  requestedCapability,
  waitForCapabilityDecision,
  writeCapabilityRequestFile,
  type CapabilityGrant,
} from "../../lib/subagent-capability.ts";
import { decideNetwork, loadNetworkMode } from "./network-policy.ts";
import { preReviewBashCommand, rethrowWithApprovalComment } from "../../lib/bash-approval.ts";

const PROMPT_SNIPPET = "Execute a bash command in the isolated worker sandbox. Risky commands block until the parent agent approves or denies them.";
const PROMPT_GUIDELINES = [
  "bash 在 worker 中经过文件系统沙箱；不要尝试读取凭据或绕过隔离。",
  "worker 的 bash 默认在内核层断网（只有 Unix socket 可用）：需要出网的命令会阻塞等待主 agent 审批，获批后才带网；被拒时不要假装已经联网，换个不需要网络的方式继续。",
  "worker 的读面是白名单（系统目录 + 工具链缓存 + 工作目录与派工可写根）：白名单外的路径读不到，确实需要就把目录报给主 agent。",
  `bash 默认 ${DEFAULT_BASH_TIMEOUT_SECONDS} 秒超时（超时杀整个进程组），与主 agent 一致；构建、测试、安装这类预期更久的命令要显式传 timeout 参数，否则会被按超时终止。`,
  "如果命令需要网络或其他额外能力，工具会阻塞等待主 agent 审批；被拒绝时按返回的理由换个安全写法继续，不要假装已经获批。",
] as const;

/**
 * 本条命令的沙箱网络档：已获批 network 的精确命令带网，其余一律断网。
 * 直接写进 env（不依赖未设时的默认值），worker 的档位在 spawnHook 里就是显式的。
 */
export function networkEnvForCommand(command: string, granted: Set<string>): "allow" | "block" {
  return granted.has(`network:${commandDigest(command)}`) ? "allow" : "block";
}

/**
 * 命令风险先过模型：true 表示这次命令可以不惊动用户直接执行。
 *
 * 抽成纯函数是为了能单测判据本身——worker 里那段执行路径要搭 env 与假工具面才跑得起来。
 * 网络档与已获批情形一律返回 false（各自由调用方处理），预审自身出错也返回 false：
 * 拿不准就老老实实问人。
 */
export async function autoApproveCommandByReview(opts: {
	commandRisk: boolean;
	networkRisk: boolean;
	preReview: () => Promise<{ autoApproved: boolean }>;
}): Promise<boolean> {
	if (!opts.commandRisk || opts.networkRisk) return false;
	try {
		return (await opts.preReview()).autoApproved;
	} catch {
		return false;
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

  const bashDef = createBashToolDefinition(cwd, {
    shellPath,
    // 网络：worker 默认断网（sandbox-shell 的 seccomp 层），只有走通了 network 审批的
    // 精确命令才带网。审核链判漏的命令因此也出不去——这是「审核 + 内核兜底」两层里的第二层。
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: { ...env, PI_SANDBOX_NET: networkEnvForCommand(command, granted) },
    }),
  });

  pi.registerTool({
    ...bashDef,
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: [...PROMPT_GUIDELINES],
    // 与主 agent 同一套默认超时：没有这个，卡死的命令会让 worker 永远碰不到
    // 暂存检查点，续跑与强停都够不着它，只能等总预算到点硬杀
    parameters: withTimeoutDoc(bashDef.parameters),
    prepareArguments(args) {
      return withDefaultTimeout(args) as never;
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const command = typeof params.command === "string" ? params.command : "";

      // 包管理器边界：系统提示里写了「一律 pnpm」，但提示挡不住真跑，
      // 而 bash 是 worker 碰命令的唯一入口，就在这里拦。早于能力审批，
      // 免得为一个本来就不该跑的 npm install 去跟主 agent 要网络能力
      const foreign = findForeignPackageManager(command);
      if (foreign) {
        return {
          content: [{ type: "text", text: foreignPackageManagerMessage(foreign) }],
          details: {} as BashToolDetails,
        };
      }

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

      // network 这一维按档位判（network-policy.ts）：
      //   off        一律不发请求（网络不算能力，不留痕）
      //   whitelist  免审集合内的命令不发（与接入档位前一致），其余发
      //   loose      一律发：由父进程做权威判定并留审计 —— 这正是 loose 与 off 的差别
      const networkMode = requested?.capability === "network" ? loadNetworkMode() : undefined;
      const networkDecision = networkMode ? decideNetwork(command, networkMode) : undefined;
      const networkRisk = networkDecision
        ? !(networkMode === "off" || (networkMode === "whitelist" && networkDecision.allow))
        : false;
      const commandRisk = !verdict.allow;
      let approvalComment: string | undefined;

      // 先问模型，再决定要不要惊动人。worker 的命令风险过一遍主 agent 同款预审
      // （同一条链、同一份缓存）：判 safe 且档位 auto 就把这次命令就地记成已获批，
      // 下面的请求分支自然跳过，用户不会被叫醒。
      // 网络档不在这里放行：外网暴露不该由模型单独拍板，照旧走审批。
      if (commandRisk && !networkRisk) {
        const key = `command:${commandDigest(command)}`;
        if (!granted.has(key)) {
          const approved = await autoApproveCommandByReview({
            commandRisk,
            networkRisk,
            preReview: () => preReviewBashCommand({ pi, ctx, command, verdict, taskId, signal }),
          });
          if (approved) granted.add(key);
        }
      }

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
              ? (networkDecision?.reason ?? `worker 命令需要额外能力：${requested?.scope ?? "访问网络或远程包源"}`)
              : (verdict.reason ?? "命令命中 worker 安全规则，需要主 agent 审批。"),
            cwd: ctx.cwd,
            taskId,
            scope: networkRisk ? (requested?.scope ?? "访问网络或远程包源") : "命令安全规则需要主 agent 审批",
          });
          if (!writeCapabilityRequestFile(requestPath, request)) {
            return {
              content: [{ type: "text", text: "权限请求写入失败，命令未执行。" }],
              details: {} as BashToolDetails,
            };
          }
          // 在工具调用内阻塞等待：不 kill worker，保留上下文与进度
          const decision = await waitForCapabilityDecision(request.requestId, {
            readDecision: () => readCapabilityDecisionFile(responsePath),
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
          // 附言只属于本次获批命令；在工具结果中显式交给 worker 模型。
          // 空白附言已由审批链 trim/丢弃，因此没有附言时完全不改原结果。
          approvalComment = decision.comment?.trim() || undefined;
        }
      }

      const result = await bashDef
        .execute(toolCallId, params, signal, onUpdate, ctx)
        .catch((err) => rethrowWithApprovalComment(err, approvalComment ? `[主 agent 附言] ${approvalComment}` : undefined));
      if (!approvalComment) return result;
      const index = result.content.findIndex((part) => part.type === "text");
      if (index < 0) return result;
      const content = result.content.map((part, i) =>
        i === index && part.type === "text"
          ? { ...part, text: `[主 agent 附言] ${approvalComment}\n${part.text}` }
          : part,
      );
      return { ...result, content };
    },
  });
}
