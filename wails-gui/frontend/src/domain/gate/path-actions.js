// Gate 目录授权草稿：点同意/拒绝前可对多个目录反复标记，不关窗、不落盘。

import { isPathCovered, pathTrustState } from "./highlights.js";

const DRAFT_LABELS = {
  allow: "将长期信任",
  "session-trust": "将本 session 信任",
  "session-write": "将本 session 可写",
  block: "将加入黑名单",
  revoke: "将取消授权",
};

function asDrafts(drafts) {
  return drafts && typeof drafts === "object" ? drafts : {};
}

function asRoots(roots) {
  return {
    persistentRoots: Array.isArray(roots?.persistentRoots) ? roots.persistentRoots : [],
    sessionTrustedRoots: Array.isArray(roots?.sessionTrustedRoots) ? roots.sessionTrustedRoots : [],
    sessionWriteRoots: Array.isArray(roots?.sessionWriteRoots) ? roots.sessionWriteRoots : [],
  };
}

export function hasExactGrant(path, roots) {
  const lists = asRoots(roots);
  return [lists.persistentRoots, lists.sessionTrustedRoots, lists.sessionWriteRoots].some((list) => list.includes(path));
}

export function cyclePathDraft(drafts, path, list) {
  if (typeof path !== "string" || !path || typeof list !== "string" || !list) return { ...asDrafts(drafts) };
  const next = { ...asDrafts(drafts) };
  if (next[path] === list) delete next[path];
  else next[path] = list;
  return next;
}

export function cancelPathAuthorization(drafts, path, roots) {
  if (typeof path !== "string" || !path) return { ...asDrafts(drafts) };
  const next = { ...asDrafts(drafts) };
  if (next[path]) {
    delete next[path];
    return next;
  }
  if (hasExactGrant(path, asRoots(roots))) next[path] = "revoke";
  return next;
}

export function pathDraftsToActions(drafts) {
  return Object.entries(asDrafts(drafts)).map(([path, list]) => ({ path, list }));
}

export function pathDraftSummary(drafts) {
  const count = Object.keys(asDrafts(drafts)).length;
  if (count === 0) return "";
  return `已暂存 ${count} 项目录操作`;
}

export function pathRowModel(path, roots, drafts = {}) {
  const lists = asRoots(roots);
  const draft = asDrafts(drafts)[path] ?? null;
  const persistentNow = isPathCovered(path, lists.persistentRoots);
  const sessionTrustNow = isPathCovered(path, lists.sessionTrustedRoots);
  const effectivePersistent = draft === "allow" || (draft == null && persistentNow);
  const effectiveSessionTrust = draft === "session-trust" || (draft == null && !persistentNow && sessionTrustNow);

  return {
    draft,
    label: DRAFT_LABELS[draft] ?? pathTrustState(path, lists),
    pending: draft !== null,
    showPersistent: !effectivePersistent || draft === "allow",
    showSession: (!effectivePersistent && !effectiveSessionTrust) || draft === "session-trust",
    showBlock: true,
    persistentPending: draft === "allow",
    sessionPending: draft === "session-trust",
    blockPending: draft === "block",
    cancelLabel: draft ? "取消标记" : hasExactGrant(path, lists) ? "取消授权" : null,
  };
}
