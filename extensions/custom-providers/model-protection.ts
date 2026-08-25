import type { ModelOverride, ProtectedModelAction } from "./types.ts";

const PROTECTED_ACTIONS = new Set<ProtectedModelAction>(["remove", "update", "edit"]);

/**
 * 读取模型保护策略。未知值会被忽略，避免拼写错误意外改变行为。
 */
export function protectedActions(model: { do_not?: unknown }): Set<ProtectedModelAction> {
  const actions = Array.isArray(model.do_not) ? model.do_not : [];
  return new Set(actions.filter((action): action is ProtectedModelAction =>
    typeof action === "string" && PROTECTED_ACTIONS.has(action as ProtectedModelAction),
  ));
}

export function isProtected(model: { do_not?: unknown }, action: ProtectedModelAction): boolean {
  return protectedActions(model).has(action);
}

/**
 * 在线列表是供应商视角；本地标记为 remove 的模型即使不再返回，也必须保留。
 */
export function mergeOnlineModelIds(
  onlineIds: string[],
  existingModels: ModelOverride[],
): string[] {
  const result = [...onlineIds];
  const seen = new Set(result);
  for (const model of existingModels) {
    if (isProtected(model, "remove") && !seen.has(model.id)) {
      result.push(model.id);
      seen.add(model.id);
    }
  }
  return result;
}

/**
 * update 保护冻结整个本地模型覆盖；没有 update 保护时沿用在线/metadata 刷新结果。
 */
export function preserveProtectedUpdate(
  candidate: ModelOverride,
  existing: ModelOverride | undefined,
): ModelOverride {
  if (!existing || !isProtected(existing, "update")) return candidate;
  return {
    ...candidate,
    ...existing,
    do_not: existing.do_not,
  };
}

export function protectActionLabel(action: ProtectedModelAction): string {
  return action === "remove" ? "在线移除" : action === "update" ? "自动更新" : "手动编辑/删除";
}
