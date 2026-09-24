// memory-gate.ts — 派工前的内存闸
//
// 为什么需要：worker 的内存墙是「每条命令」1GiB，不是「每批」1GiB；并发安全阀又只数 worker 个数。
// 八个 worker 各跑一条接近 1G 的命令就是 8G，会把桌面 + 主 agent 一起推进交换
// （本机 15G 内存、桌面已占 11G、swap 已用 4.9G）。这里在 spawn 之前按可用内存算一个并发上限，
// 超出的 worker 照旧排队（queued），并在派工回报里写清算出来的依据。
//
// 三个数的分工要说清，否则容易拧着劲：
//   planMb   每个 worker 的「典型占用」计划值：node 进程 + 普通命令的常见水位
//   wallMb   单条命令的墙（sandbox-shell 默认 1GiB）：这是上限，不是典型值
//   reserve  留给桌面与主 agent 的保留量
// 计划值小于墙，所以两者之差就是理论超订空间；保留量就是为它留的。
//
// 为什么不把墙降到 700/800MB：墙一降，本来能跑的命令会变成退出码 137，
// 而且模型看不到原因。要少开并发就少开并发，别动墙。

import { readFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 留给桌面与主 agent 的保留量（MB）缺省值 */
export const DEFAULT_RESERVE_MB = 2048;
/** 每个 worker 的典型占用计划值（MB）缺省值 */
export const DEFAULT_PLAN_MB = 512;
/** 计划值的下限：再小就不是「少开并发」，而是假装 worker 不占内存 */
export const MIN_PLAN_MB = 128;

export interface MemoryGateConfig {
  reserveMb: number;
  planMb: number;
  /** 无论内存多宽裕都不超过它（上游配额与调度复杂度决定的阀） */
  safetyCap: number;
}

export interface MemoryGateInput extends MemoryGateConfig {
  availableMb: number;
  /** 本批想派的 worker 数 */
  taskCount: number;
}

export interface MemoryGateResult {
  /** 实际并行上限：至少 1（一个都不开比超订更难用，人在盯着） */
  limit: number;
  /** 只按内存算出来的上限（未夹到 safetyCap / taskCount） */
  memoryLimit: number;
  /** 给模型/人看的依据，一行 */
  reason: string;
}

function positiveInt(value: unknown, fallback: number, min = 1): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  return floored >= min ? floored : fallback;
}

/**
 * 按可用内存算本次能真正并行几个 worker（纯函数）。
 *
 * 结果至少 1：内存紧张时仍然开一个，把「为什么只开一个」写在 reason 里，
 * 而不是让整批原地不动、人对着一个不动的面板猜。
 */
export function planMemoryGate(input: MemoryGateInput): MemoryGateResult {
  // 非有限值（NaN/Infinity/undefined）一律拾回缺省：闸自己不能变成 NaN，否则下游拿到的是垃圾上限
  const finite = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);
  const planMb = Math.max(MIN_PLAN_MB, Math.floor(finite(input.planMb, DEFAULT_PLAN_MB)));
  const reserveMb = Math.max(0, Math.floor(finite(input.reserveMb, DEFAULT_RESERVE_MB)));
  const safetyCap = Math.max(1, Math.floor(finite(input.safetyCap, 1)));
  const availableMb = Math.max(0, Math.floor(finite(input.availableMb, 0)));
  const taskCount = Math.max(1, Math.floor(finite(input.taskCount, 1)));
  const budgetMb = availableMb - reserveMb;
  const memoryLimit = budgetMb <= 0 ? 0 : Math.floor(budgetMb / planMb);
  const limit = Math.max(1, Math.min(memoryLimit, safetyCap, taskCount));
  const head = `内存闸：可用 ${availableMb}MB − 保留 ${reserveMb}MB = ${Math.max(0, budgetMb)}MB`;
  const tail = `每 worker 计划 ${planMb}MB（命令墙仍是 1GiB，此处按典型值算）`;
  const reason =
    memoryLimit <= 0
      ? `${head}，不够一个 worker 的计划值，仍先开 1 个（内存紧张，其余排队）；${tail}`
      : `${head} ÷ ${planMb}MB → ${Math.min(memoryLimit, safetyCap)}（安全阀 ${safetyCap}，本批 ${taskCount} 个）；${tail}`;
  return { limit, memoryLimit, reason };
}

/** 可用内存（MB）：Linux 读 /proc/meminfo 的 MemAvailable，其他平台退回 os.freemem */
export function readAvailableMb(): number {
  try {
    const info = readFileSync("/proc/meminfo", "utf8");
    const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info);
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch {
    // 非 Linux 或读不到：走 os.freemem
  }
  return Math.floor(freemem() / (1024 * 1024));
}

/** 读 extensions.toml 的 [subagent-memory]；读不到就用缺省值（缺省是保守值，不是放行） */
export function readMemoryGateConfig(path = join(getAgentDir(), "extensions.toml")): { reserveMb: number; planMb: number } {
  try {
    const doc = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
    const section = (doc["subagent-memory"] ?? {}) as Record<string, unknown>;
    return {
      reserveMb: positiveInt(section.reserveMb, DEFAULT_RESERVE_MB, 0),
      planMb: positiveInt(section.planMb, DEFAULT_PLAN_MB, MIN_PLAN_MB),
    };
  } catch {
    return { reserveMb: DEFAULT_RESERVE_MB, planMb: DEFAULT_PLAN_MB };
  }
}
