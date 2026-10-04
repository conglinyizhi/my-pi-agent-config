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
    builtinRoots: Array.isArray(roots?.builtinRoots) ? roots.builtinRoots : [],
    workspaceRoot: typeof roots?.workspaceRoot === "string" ? roots.workspaceRoot : "",
  };
}

export function isBuiltinWritable(path, roots) {
  return isPathCovered(path, asRoots(roots).builtinRoots);
}

export function hasExactGrant(path, roots) {
  const lists = asRoots(roots);
  return [lists.persistentRoots, lists.sessionTrustedRoots, lists.sessionWriteRoots].some((list) => list.includes(path));
}

export function cyclePathDraft(drafts, path, list, roots) {
  if (typeof path !== "string" || !path || typeof list !== "string" || !list) return { ...asDrafts(drafts) };
  if (isBuiltinWritable(path, roots)) return { ...asDrafts(drafts) };
  const next = { ...asDrafts(drafts) };
  if (next[path] === list) delete next[path];
  else next[path] = list;
  return next;
}

export function cancelPathAuthorization(drafts, path, roots) {
  if (typeof path !== "string" || !path) return { ...asDrafts(drafts) };
  if (isBuiltinWritable(path, roots)) return { ...asDrafts(drafts) };
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
  if (isBuiltinWritable(path, lists) && draft == null) {
    return {
      draft: null,
      label: pathTrustState(path, lists),
      pending: false,
      locked: true,
      showPersistent: false,
      showSession: false,
      showBlock: false,
      persistentPending: false,
      sessionPending: false,
      blockPending: false,
      cancelLabel: null,
    };
  }
  const persistentNow = isPathCovered(path, lists.persistentRoots);
  const sessionTrustNow = isPathCovered(path, lists.sessionTrustedRoots);
  const effectivePersistent = draft === "allow" || (draft == null && persistentNow);
  const effectiveSessionTrust = draft === "session-trust" || (draft == null && !persistentNow && sessionTrustNow);

  return {
    draft,
    label: DRAFT_LABELS[draft] ?? pathTrustState(path, lists),
    pending: draft !== null,
    locked: false,
    showPersistent: !effectivePersistent || draft === "allow",
    showSession: (!effectivePersistent && !effectiveSessionTrust) || draft === "session-trust",
    showBlock: true,
    persistentPending: draft === "allow",
    sessionPending: draft === "session-trust",
    blockPending: draft === "block",
    cancelLabel: draft ? "取消标记" : hasExactGrant(path, lists) ? "取消授权" : null,
  };
}

// ---- 执行范围编辑与副工作区 ----
// 护栅与后端 normalizeSandboxRoot / resolveEditedWritePaths / isHomeRootPath 同构：
// GUI 只做即时反馈，后端收到响应后会自己再算一遍，不依赖这里的拦截。

function asPathOptions(options) {
  return {
    homeDir: typeof options?.homeDir === "string" ? options.homeDir : "",
    workspaceRoot: typeof options?.workspaceRoot === "string" ? options.workspaceRoot : "",
  };
}

function normalizeScopePaths(paths, options) {
  const result = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    const normalized = normalizeScopePath(path, options);
    if (normalized !== null && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

/** 一方在另一方之下（同路径另算） */
function isRelatedPath(a, b) {
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** 编辑范围与副工作区共用的祖先/后代判定，同路径也算相关 */
function isRelatedOrSamePath(a, b) {
  return a === b || isRelatedPath(a, b);
}

function asRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

/**
 * 归一化执行范围路径：展开 ~、相对路径挂到工作区根、折叠 . 与 ..。
 * 根目录、空值、缺少家目录信息时的 ~ 返回 null（与 normalizeSandboxRoot 的拒绝口径一致）。
 */
export function normalizeScopePath(path, options) {
  const text = typeof path === "string" ? path.trim() : "";
  if (!text) return null;
  const { homeDir, workspaceRoot } = asPathOptions(options);
  let expanded = text;
  if (text === "~" || text.startsWith("~/")) {
    if (!homeDir) return null;
    expanded = text === "~" ? homeDir : `${homeDir}/${text.slice(2)}`;
  }
  const absolute = expanded.startsWith("/") ? expanded : workspaceRoot ? `${workspaceRoot}/${expanded}` : `/${expanded}`;
  const segments = [];
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return `/${segments.join("/")}`;
}

/**
 * 编辑执行范围的护栅：新路径必须与某个原始候选互为祖先或后代（同路径也算）。
 * 授权候选仍是申请里声明的 writePaths，编辑只改本次执行范围。
 */
export function checkScopeEdit(path, candidatePaths, options) {
  const normalized = normalizeScopePath(path, options);
  if (normalized === null) return { ok: false, path: "", candidate: null, reason: "路径无效（不能是 / 或空）" };
  const candidate = normalizeScopePaths(candidatePaths, options).find((item) => isRelatedOrSamePath(normalized, item)) ?? null;
  if (candidate === null) return { ok: false, path: normalized, candidate: null, reason: "必须与原始候选互为父/子目录" };
  return { ok: true, path: normalized, candidate, reason: "" };
}

/**
 * 设为副工作区的护栅：任意目录都行，但 "/"（上面已挡）与家目录根本身不授予。
 * 后端 isHomeRootPath 会再挡一次，这里只是先把话说清楚。
 */
export function checkWorkspacePath(path, options) {
  const normalized = normalizeScopePath(path, options);
  if (normalized === null) return { ok: false, path: "", reason: "路径无效（不能是 / 或空）" };
  const home = normalizeScopePath(asPathOptions(options).homeDir, options);
  if (home !== null && normalized === home) return { ok: false, path: normalized, reason: "家目录根不能设为副工作区，请指定下面的子目录" };
  return { ok: true, path: normalized, reason: "" };
}

/** 每个原始候选一行：candidate 是授权判定基准，path 是可编辑的执行范围 */
export function createScopeRows(candidatePaths) {
  return (Array.isArray(candidatePaths) ? candidatePaths : []).map((path, index) => ({
    key: `c${index}`,
    candidate: String(path),
    path: String(path),
  }));
}

export function editScopeRow(rows, key, path) {
  return asRows(rows).map((row) => (row.key === key ? { ...row, path: typeof path === "string" ? path : "" } : row));
}

export function removeScopeRow(rows, key) {
  return asRows(rows).filter((row) => row.key !== key);
}

/** 新增行的 key 取 n1、n2……；只用于 v-for 稳定性，父组件不再传 */
export function appendScopeRow(rows, path) {
  const list = asRows(rows);
  const next =
    list.reduce((max, row) => {
      const match = /^n(\d+)$/.exec(typeof row.key === "string" ? row.key : "");
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
  return [...list, { key: `n${next}`, candidate: null, path: typeof path === "string" ? path : "" }];
}

/** 用户是否动过执行范围；增/删/改都算，原样放回不算 */
export function scopeChanged(rows, candidatePaths, options) {
  const current = normalizeScopePaths(
    asRows(rows).map((row) => row.path),
    options,
  ).sort();
  const base = normalizeScopePaths(candidatePaths, options).sort();
  return current.length !== base.length || current.some((path, index) => path !== base[index]);
}

/** 提交时发给后端的完整执行范围（归一化去重）：动过一条也要把所有行带上 */
export function scopeWritePaths(rows, options) {
  return normalizeScopePaths(
    asRows(rows).map((row) => row.path),
    options,
  );
}

/** 没通过护栅的行：非空时不允许提交 allow，否则后端会把这些行丢掉，范围与所见不一致 */
export function scopeIssues(rows, candidatePaths, options) {
  const issues = [];
  for (const row of asRows(rows)) {
    const guard = checkScopeEdit(row.path, candidatePaths, options);
    if (!guard.ok) issues.push({ key: row.key ?? "", path: typeof row.path === "string" ? row.path : "", reason: guard.reason });
  }
  return issues;
}

/**
 * 行的视图模型：护栅结果 + 信任标记。
 * 三个授权按钮只在「行路径仍是它的原始候选」时可用——后端只认申请里声明的候选；
 * 编辑出来的路径要走副工作区。
 */
export function scopeRowModel(row, candidatePaths, context = {}) {
  const options = asPathOptions(context);
  const guard = checkScopeEdit(row?.path, candidatePaths, options);
  const candidate = typeof row?.candidate === "string" && row.candidate !== "" ? row.candidate : null;
  const normalizedCandidate = candidate === null ? null : normalizeScopePath(candidate, options);
  const trustable = guard.ok && normalizedCandidate !== null && guard.path === normalizedCandidate;
  const trust = trustable ? pathRowModel(normalizedCandidate, context.roots, context.drafts) : null;
  const roots = asRoots(context.roots);
  return {
    key: typeof row?.key === "string" ? row.key : "",
    input: typeof row?.path === "string" ? row.path : "",
    path: guard.path,
    candidate,
    added: candidate === null,
    guard,
    trustable,
    label: trust ? trust.label : guard.ok ? pathTrustState(guard.path, roots) : "路径无效",
    trust,
  };
}

/** 副工作区（持久 allowDirs）动作：一次审批可以给多个目录 */
export function workspaceActions(paths) {
  return (Array.isArray(paths) ? paths : [])
    .filter((path) => typeof path === "string" && path !== "")
    .map((path) => ({ path, list: "workspace" }));
}
