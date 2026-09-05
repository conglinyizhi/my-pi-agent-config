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
