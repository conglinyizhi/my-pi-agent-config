// lib/subagent-capability.ts — subagent 无 UI capability 请求协议
//
// 请求由 worker 内的沙箱 guard 产生，父进程审批；批准绑定到精确 commandDigest，
// 不把一次批准扩大成 worker 生命周期内的泛权限。

import { createHash, randomUUID } from "node:crypto";

export type CapabilityName = "network" | "command" | "publish" | "read-secrets";

export interface CapabilityGrant {
  capability: CapabilityName;
  commandDigest: string;
}

export interface CapabilityRequest {
  version: 1;
  requestId: string;
  capability: CapabilityName;
  command: string;
  commandDigest: string;
  reason: string;
  cwd: string;
  taskId?: string;
  scope?: string;
  createdAt: string;
}

export function commandDigest(command: string): string {
  return `sha256:${createHash("sha256").update(command, "utf8").digest("hex")}`;
}

function firstCommand(command: string): string {
  const segment = command.split(/&&|\|\||;|\||\n/, 1)[0]?.trim() ?? "";
  const tokens = segment.match(/"([^\"]*)"|'([^']*)'|(\S+)/g) ?? [];
  const first = tokens[0] ?? "";
  return first.replace(/^['"]|['"]$/g, "").split("/").pop() ?? "";
}

/**
 * 只识别能力边界，不负责判断命令是否安全：
 * - publish 单独分出，当前策略不默认开放；
 * - 常见下载/包管理/远程 git 命令归 network；
 * - 其余由 checkCommand 的危险规则归 command。
 */
export function requestedCapability(command: string): { capability: CapabilityName; scope: string } | undefined {
  const text = command.toLowerCase();
  const cmd = firstCommand(command).toLowerCase();

  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:publish|pack\b.*--publish)/.test(text) ||
    /\bcargo\s+publish\b/.test(text) ||
    /\bgit\s+push\b/.test(text)
  ) {
    return { capability: "publish", scope: "远端写入/发布" };
  }

  if (
    ["curl", "wget", "http", "ssh", "scp", "sftp"].includes(cmd) ||
    /(?:^|[;&|]\s*)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:[\w./-]*\/)?(?:curl|wget|http|ssh|scp|sftp)\b/.test(text) ||
    /\bgit\s+(?:clone|fetch|pull|submodule\s+(?:add|update))\b/.test(text) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|update|remove)\b/.test(text) ||
    /\b(?:uv\s+pip|pip3?|poetry)\s+(?:install|add|update)\b/.test(text) ||
    /\b(?:go|cargo)\s+(?:get|add|install|fetch)\b/.test(text)
  ) {
    return { capability: "network", scope: "访问网络或远程包源" };
  }

  return undefined;
}

export function validateCapabilityRequest(value: unknown): CapabilityRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const request = value as Record<string, unknown>;
  const capability = request.capability;
  if (
    request.version !== 1 ||
    typeof request.requestId !== "string" || !request.requestId.startsWith("cap-") ||
    !["network", "command", "publish", "read-secrets"].includes(String(capability)) ||
    typeof request.command !== "string" || request.command.length === 0 ||
    typeof request.commandDigest !== "string" ||
    request.commandDigest !== commandDigest(request.command) ||
    typeof request.reason !== "string" ||
    typeof request.cwd !== "string" ||
    typeof request.createdAt !== "string"
  ) {
    return undefined;
  }
  const inferred = requestedCapability(request.command);
  if (capability === "network" && inferred?.capability !== "network") return undefined;
  if (capability === "command" && inferred?.capability === "publish") return undefined;
  return value as CapabilityRequest;
}

export function makeCapabilityRequest(input: Omit<CapabilityRequest, "version" | "requestId" | "commandDigest" | "createdAt">): CapabilityRequest {
  return {
    version: 1,
    requestId: `cap-${randomUUID()}`,
    commandDigest: commandDigest(input.command),
    createdAt: new Date().toISOString(),
    ...input,
  };
}

export function hasMatchingGrant(command: string, capability: CapabilityName, grants: CapabilityGrant[]): boolean {
  const digest = commandDigest(command);
  return grants.some((grant) => grant.capability === capability && grant.commandDigest === digest);
}

/** 消费一次性 grant；同一 worker 进程内同一命令只能获批一次。 */
export function consumeMatchingGrant(command: string, capability: CapabilityName, grants: CapabilityGrant[]): boolean {
  const digest = commandDigest(command);
  const index = grants.findIndex((grant) => grant.capability === capability && grant.commandDigest === digest);
  if (index < 0) return false;
  grants.splice(index, 1);
  return true;
}

/**
 * 子 agent 的本地网络自动审核。
 *
 * 只允许可枚举的开发期拉取命令，且命令必须是单段静态 shell 调用：
 * 包管理器依赖操作、git 的只读同步，以及不落盘/不执行的 curl、wget。
 * 任何重定向、管道、命令替换、动态变量、远端写入或未知参数都回退人工审批。
 * 这不是通用的网络白名单；新命令先人工审核，确认安全后再显式加入。
 */
export function isWorkerNetworkAutoApproved(command: string): boolean {
  const text = command.trim();
  if (!text || /(?:&&|\|\||[;|`<>\n]|\$(?:[A-Za-z_]|\{|\())/.test(text)) return false;

  // 只处理简单 token；带引号的参数可以安全传递，但不允许引号内嵌 shell 控制字符。
  const tokens = text.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g);
  if (!tokens?.length) return false;
  const unquote = (token: string) => token.replace(/^(?:"|')|(?:"|')$/g, "");
  const args = tokens.map(unquote);
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[index] ?? "")) index++;
  const executable = (args[index] ?? "").split("/").pop()?.toLowerCase();
  const rest = args.slice(index + 1);

  // 远端写入/发布永远不属于自动放行集合，即使调用方分类出现遗漏也要二次卡住。
  if (/\b(?:publish|push)\b/i.test(rest.join(" "))) return false;

  if (["pnpm", "npm", "yarn", "bun"].includes(executable ?? "")) {
    return ["install", "add", "update", "remove", "ci"].includes((rest[0] ?? "").toLowerCase());
  }
  if (["uv", "pip", "pip3", "poetry", "go", "cargo"].includes(executable ?? "")) {
    const operation = executable === "uv" ? `${rest[0] ?? ""} ${rest[1] ?? ""}`.toLowerCase() : (rest[0] ?? "").toLowerCase();
    return ["pip install", "install", "add", "update", "get", "fetch"].includes(operation);
  }
  if (executable === "git") {
    return ["clone", "fetch", "pull"].includes((rest[0] ?? "").toLowerCase()) ||
      (rest[0] === "submodule" && ["add", "update"].includes((rest[1] ?? "").toLowerCase()));
  }
  if (executable === "curl" || executable === "wget") {
    // 下载后写文件、提交数据、指定非 GET 方法都留给人工/LLM 兜底；只允许读到 stdout。
    return !rest.some((arg, i) =>
      ["-o", "-O", "--output", "--remote-name", "-d", "--data", "--data-raw", "-F", "--form", "-T", "--upload-file"].includes(arg) ||
      ((arg === "-X" || arg === "--request") && (rest[i + 1] ?? "").toUpperCase() !== "GET"),
    );
  }
  return false;
}

/** 规则未覆盖时，只有纯只读的远端元数据查询才允许交给父会话的 LLM 复核。 */
export function isWorkerNetworkLlmReviewable(command: string): boolean {
  const text = command.trim();
  if (!text || /(?:&&|\|\||[;|`<>\n]|\$(?:[A-Za-z_]|\{|\()|\b(?:push|publish|upload|--upload-file|--data|--form|post|put|patch|delete)\b)/i.test(text)) return false;
  const tokens = text.split(/\s+/);
  const executable = (tokens[0] ?? "").split("/").pop()?.toLowerCase();
  return executable === "git" && tokens[1]?.toLowerCase() === "ls-remote";
}

export function isWorkerApprovalCapability(capability: CapabilityName): boolean {
  // 当前只把 network 与普通命令风险交给主对话审批；publish/read-secrets 不开放。
  return capability === "network" || capability === "command";
}

export function parseCapabilityGrants(raw: string | undefined): CapabilityGrant[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is CapabilityGrant => {
      if (!item || typeof item !== "object") return false;
      const grant = item as Record<string, unknown>;
      return typeof grant.capability === "string" && typeof grant.commandDigest === "string";
    });
  } catch {
    return [];
  }
}
