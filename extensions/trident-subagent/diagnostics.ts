// diagnostics.ts — subagent 本地执行档案（仅本机，不进模型上下文、不进 Git）
//
// 记录父进程可验证得到的信息：规范化任务、worker 配置、实时快照、可见 timeline、
// 权限请求、终态 output/stderr。隐藏 reasoning/CoT 从未进入本模块。

import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkerRun } from "./status.ts";

const DEFAULT_ROOT = join(homedir(), ".pi", "subagent-diagnostics");
let root = DEFAULT_ROOT;

export interface DiagnosticContext {
  batchId: string;
  createdAt: string;
  cwd: string;
  model: string;
  workerPrompt: string;
  /** Pi 最终 resolved system prompt 当前无官方父子回传；此字段保存可重建的来源。 */
  systemPrompt: { kind: "reconstructable-input"; stableInstruction: string; skillPaths: string[][]; tools: string[]; extraExtensions: string[] };
}

interface ArchiveDocument extends DiagnosticContext {
  version: 1;
  updatedAt: string;
  workers: WorkerRun[];
}

let context: DiagnosticContext | undefined;

function archivePath(batchId: string): string {
  return join(root, `${batchId}.json`);
}

function atomicWrite(path: string, data: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(temp, data, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temp, path);
}

export function beginDiagnostics(next: DiagnosticContext): void {
  context = next;
}

/** 每次状态快照落盘后调用；归档失败绝不影响 worker 调度。 */
export function archiveDiagnostics(workers: WorkerRun[]): void {
  if (!context) return;
  const document: ArchiveDocument = {
    version: 1,
    ...context,
    updatedAt: new Date().toISOString(),
    workers: structuredClone(workers),
  };
  try {
    atomicWrite(archivePath(context.batchId), JSON.stringify(document, null, 2));
  } catch {
    // 诊断能力为旁路；磁盘失败不能阻断任务。
  }
}

export function clearDiagnosticsContext(): void {
  context = undefined;
}

export function diagnosticsRoot(): string {
  return root;
}

/** 测试注入：诊断档案始终只写本机目录，生产默认 ~/.pi/subagent-diagnostics。 */
export function configureDiagnosticsRoot(path?: string): void {
  root = path ?? DEFAULT_ROOT;
  context = undefined;
}
