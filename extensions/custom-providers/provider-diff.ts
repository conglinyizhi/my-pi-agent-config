/**
 * 模型列表差异比较
 *
 * 用于 /provider:reload 和 /provider:reload-online 完成后
 * 向用户报告模型变更：新增/移除/价格变动/能力变化
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ─── 类型 ───────────────────────────────────────────

export interface ModelDiff {
  /** 新增的模型 ID */
  added: string[];
  /** 移除的模型 ID */
  removed: string[];
  /** 价格有变化的模型 */
  priceChanges: PriceChange[];
  /** 能力有变化的模型（上下文、模态、推理等） */
  capabilityChanges: CapabilityChange[];
}

interface PriceChange {
  modelId: string;
  field: string;
  oldValue: number;
  newValue: number;
}

interface CapabilityChange {
  modelId: string;
  changes: string[];
}

// ─── 比较逻辑 ───────────────────────────────────────

/**
 * 比较新旧模型列表，生成差异报告
 *
 * @param oldModels 刷新前的模型列表
 * @param newModels 刷新后的模型列表
 */
export function diffModelLists(
  oldModels: ProviderModelConfig[],
  newModels: ProviderModelConfig[],
): ModelDiff {
  const oldMap = new Map(oldModels.map(m => [m.id, m]));
  const newMap = new Map(newModels.map(m => [m.id, m]));

  const added: string[] = [];
  const removed: string[] = [];
  const priceChanges: PriceChange[] = [];
  const capabilityChanges: CapabilityChange[] = [];

  // 发现新增
  for (const id of newMap.keys()) {
    if (!oldMap.has(id)) {
      added.push(id);
    }
  }

  // 发现移除
  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) {
      removed.push(id);
    }
  }

  // 对共有模型，比较属性和价格
  for (const [id, oldM] of oldMap) {
    const newM = newMap.get(id);
    if (!newM) continue;

    // 价格比较
    const priceFields: Array<{ key: string; old: number; new: number }> = [
      { key: "输入价", old: oldM.cost.input, new: newM.cost.input },
      { key: "输出价", old: oldM.cost.output, new: newM.cost.output },
      { key: "缓存写入价", old: oldM.cost.cacheWrite, new: newM.cost.cacheWrite },
      { key: "缓存读取价", old: oldM.cost.cacheRead, new: newM.cost.cacheRead },
    ];

    for (const pf of priceFields) {
      if (pf.old !== pf.new) {
        priceChanges.push({
          modelId: id,
          field: pf.key,
          oldValue: pf.old,
          newValue: pf.new,
        });
      }
    }

    // 能力比较
    const capDiffs: string[] = [];

    if (oldM.contextWindow !== newM.contextWindow) {
      capDiffs.push(`上下文: ${formatTokens(oldM.contextWindow)} → ${formatTokens(newM.contextWindow)}`);
    }
    if (oldM.maxTokens !== newM.maxTokens) {
      capDiffs.push(`最大输出: ${formatTokens(oldM.maxTokens)} → ${formatTokens(newM.maxTokens)}`);
    }
    if (oldM.reasoning !== newM.reasoning) {
      capDiffs.push(`推理: ${oldM.reasoning ? "支持 → 不支持" : "不支持 → 支持"}`);
    }
    const oldInputs = (oldM.input || []).sort().join("+") || "无";
    const newInputs = (newM.input || []).sort().join("+") || "无";
    if (oldInputs !== newInputs) {
      capDiffs.push(`输入模态: ${oldInputs} → ${newInputs}`);
    }

    if (capDiffs.length > 0) {
      capabilityChanges.push({ modelId: id, changes: capDiffs });
    }
  }

  return { added, removed, priceChanges, capabilityChanges };
}

/**
 * 将差异报告格式化为人类可读的文本
 */
export function formatDiffReport(diff: ModelDiff, providerId: string): string | null {
  const lines: string[] = [];

  if (diff.added.length > 0) {
    lines.push(`+ ${diff.added.length} 个新模型: ${diff.added.join(", ")}`);
  }
  if (diff.removed.length > 0) {
    lines.push(`- ${diff.removed.length} 个模型移除: ${diff.removed.join(", ")}`);
  }
  for (const pc of diff.priceChanges) {
    if (pc.oldValue === 0 && pc.newValue > 0) {
      lines.push(`  ${pc.modelId} ${pc.field} 新增定价: ${fmtPrice(pc.newValue)}`);
    } else if (pc.oldValue > 0 && pc.newValue === 0) {
      lines.push(`  ${pc.modelId} ${pc.field} 定价移除（原: ${fmtPrice(pc.oldValue)}）`);
    } else {
      const arrow = pc.newValue > pc.oldValue ? "↑" : "↓";
      lines.push(
        `  ${pc.modelId} ${pc.field} ${arrow}: ${fmtPrice(pc.oldValue)} → ${fmtPrice(pc.newValue)}`,
      );
    }
  }
  for (const cc of diff.capabilityChanges) {
    lines.push(`  ${cc.modelId} 能力变化:`);
    for (const c of cc.changes) {
      lines.push(`    ${c}`);
    }
  }

  if (lines.length === 0) {
    return `"${providerId}" 无变化`;
  }

  return `"${providerId}" 变更报告:\n${lines.join("\n")}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function fmtPrice(n: number): string {
  if (n === 0) return "0";
  if (n < 0.000001) return n.toExponential(2);
  return (n * 1_000_000).toFixed(2) + "/M";
}
