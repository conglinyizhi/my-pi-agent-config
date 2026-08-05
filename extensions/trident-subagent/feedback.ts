// feedback.ts — subagent 反馈模式开关状态 + 工具白名单构造
//
// 反馈模式：后续新启动的 worker 只允许 read/bash/be-* 工具（better-edit-tools 反馈收集）。
// --tools 是精确名单不支持通配，因此从活跃工具名中过滤 be- 前缀。
// 未检测到任何 be-* 工具时拒绝开启，避免表面开启实际放行全部工具。

import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_PATH = join(homedir(), ".pi", "subagent-feedback.json");

export function readFeedbackState(): boolean {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    return (JSON.parse(raw) as { enabled?: boolean }).enabled === true;
  } catch {
    return false;
  }
}

export function writeFeedbackState(enabled: boolean): void {
  fs.mkdirSync(join(homedir(), ".pi"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ enabled }, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function buildToolsFromNames(active: string[]): { tools?: string[]; reason?: string } {
  const beTools = active.filter((t) => t.startsWith("be-")).sort();
  if (beTools.length === 0) {
    return { reason: "当前没有检测到 be-* 工具（better-edit-tools 未连接）。受限模式拒绝开启。" };
  }
  return { tools: ["read", "bash", ...beTools] };
}
