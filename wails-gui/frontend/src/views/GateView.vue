<template>
  <div v-if="ready" class="app">
    <GateCommandPreview
      :title="title"
      :task-id="taskId"
      :is-sandbox-allow="isSandboxAllow"
      :is-capability="isCapability"
      :permission="permission"
      :perm-label="permLabel"
      :capability="capability"
      :command="cmd"
      :highlights="highlights"
      :env-notes="envNotes"
      :var-renders="varRenders"
      :current="cur"
      @update:current="cur = $event"
    />

    <div v-if="varRows.length" data-name="var-table" class="var-table">
      <div class="var-head">🔎 命令里的变量（{{ varRows.length }}）</div>
      <div
        v-for="row in varRows"
        :key="row.key"
        class="var-row"
        :class="{ 'var-row-unknown': !row.known }"
      >
        <code class="var-name">{{ row.name }}</code>
        <span class="var-source">{{ row.sourceLabel }}</span>
        <code v-if="row.known" class="var-value">{{ row.value }}</code>
        <span v-else class="var-reason" :title="row.reason">解析不了：{{ row.reason || "原因不明" }}</span>
        <span v-if="row.kind" class="var-kind">{{ row.kind }}</span>
      </div>
    </div>

    <GateApprovalInfo
      :is-sandbox-allow="isSandboxAllow"
      :is-capability="isCapability"
      :permission="permission"
      :write-paths="writePaths"
      :justification="justification"
      :capability="capability"
      :capability-scope="capabilityScope"
      :request-reason="requestReason"
      :timeout="timeout"
      :memory-mb="memoryMb"
      :rules="rules"
      :review="review"
      :candidate-paths="candidatePaths"
      :persistent-roots="persistentRoots"
      :session-write-roots="sessionWriteRoots"
      :session-trusted-roots="sessionTrustedRoots"
      :builtin-roots="builtinRoots"
      :workspace-root="workspaceRoot"
      :home-dir="homeDir"
      :scope-rows="scopeRows"
      :workspace-dirs="workspaceDirs"
      :path-drafts="pathDrafts"
      :verdict-meta="verdictMeta"
      @stage-path="stagePath"
      @cancel-path="cancelPath"
      @edit-scope="editScope"
      @remove-scope="removeScope"
      @add-scope="addScope"
      @add-workspace="addWorkspace"
      @remove-workspace="removeWorkspace"
    />

    <GateActionBar
      :is-sandbox-allow="isSandboxAllow"
      :is-capability="isCapability"
      :reasons="reasons"
      :comment="comment"
      :path-draft-summary="draftSummary"
      :scope-block-reason="scopeBlockReason"
      @update:comment="comment = $event"
      @respond="respondFromAction"
      @save-reason="saveReason"
      @update-reason="updateReason"
      @delete-reason="deleteReason"
    />
  </div>
</template>

<script setup>
import "../gui-theme.css";
import { computed, onMounted, ref } from "vue";
import { usePlatform } from "../platform/index.js";
import { findHighlights } from "../domain/gate/highlights.js";
import { varRenderRows } from "../domain/gate/var-renders.js";
import { cancelPathAuthorization, createScopeRows, cyclePathDraft, editScopeRow, appendScopeRow, pathDraftsToActions, pathDraftSummary, removeScopeRow, scopeChanged, scopeIssues, scopeWritePaths, workspaceActions } from "../domain/gate/path-actions.js";
import GateActionBar from "../components/gate/GateActionBar.vue";
import GateApprovalInfo from "../components/gate/GateApprovalInfo.vue";
import GateCommandPreview from "../components/gate/GateCommandPreview.vue";

const platform = usePlatform();

const ready = ref(false);
const cmd = ref("");
const taskId = ref(null);
const rules = ref([]);
const review = ref(null);
const kind = ref("");
const permission = ref("");
const writePaths = ref([]);
const justification = ref("");
const capability = ref("");
const capabilityScope = ref("");
const requestReason = ref("");
const timeout = ref(undefined);
const memoryMb = ref(undefined);
const candidatePaths = ref([]);
const persistentRoots = ref([]);
const sessionWriteRoots = ref([]);
const sessionTrustedRoots = ref([]);
const builtinRoots = ref([]);
const workspaceRoot = ref("");
const homeDir = ref("");
const pathDrafts = ref({});
// 执行范围行（可改路径）与待提交的副工作区列表
const scopeRows = ref([]);
const workspaceDirs = ref([]);

const cur = ref(0);
/** 命令里写死的赋值解析（pi 侧算好：{name, raw, start, end, value?|reason?}） */
const envNotes = ref([]);
/** 命令里用到的变量渲染值（pi 侧算好：{name, value?, source, target, kind, known, reason?}） */
const varRenders = ref([]);
const reasons = ref([]);
const comment = ref("");

const isSandboxAllow = computed(() => kind.value === "sandbox-allow");
const isCapability = computed(() => kind.value === "capability");
const title = computed(() =>
  isSandboxAllow.value ? "🔓 跨沙箱请求（仅此一次）" : isCapability.value ? "🔐 subagent 能力请求" : "⚠️ 危险命令审计",
);
const permLabel = computed(() =>
  permission.value === "full-access" ? "完全取消沙箱" : "保持沙箱 + 额外可写",
);
const verdictMeta = computed(() => {
  const verdict = review.value?.verdict;
  if (verdict === "safe") return { label: "✅ 安全", cls: "v-safe" };
  if (verdict === "risky") return { label: "⚠️ 有风险", cls: "v-risky" };
  if (verdict === "dangerous") return { label: "🔴 危险", cls: "v-dangerous" };
  return { label: "❌ 审核失败", cls: "v-error" };
});
const highlights = computed(() => findHighlights(cmd.value, rules.value));
// 变量表：known:false 的行显示原因而不是值
const varRows = computed(() => varRenderRows(varRenders.value));
const pathRoots = computed(() => ({
  persistentRoots: persistentRoots.value,
  sessionTrustedRoots: sessionTrustedRoots.value,
  sessionWriteRoots: sessionWriteRoots.value,
  builtinRoots: builtinRoots.value,
  workspaceRoot: workspaceRoot.value,
}));
const draftSummary = computed(() => pathDraftSummary(pathDrafts.value));
const pathOptions = computed(() => ({ homeDir: homeDir.value, workspaceRoot: workspaceRoot.value }));
// 只列没有通过护栅的行，非空时不允许提交 allow（后端会自行再算一遍）
const scopeIssuesList = computed(() => (isSandboxAllow.value ? scopeIssues(scopeRows.value, candidatePaths.value, pathOptions.value) : []));
const scopeBlockReason = computed(() => (scopeIssuesList.value.length > 0 ? `${scopeIssuesList.value.length} 行执行路径无效，先修正再允许` : ""));

function stagePath({ path, list }) {
  pathDrafts.value = cyclePathDraft(pathDrafts.value, path, list, pathRoots.value);
}
function cancelPath(path) {
  pathDrafts.value = cancelPathAuthorization(pathDrafts.value, path, pathRoots.value);
}
function editScope({ key, path }) {
  scopeRows.value = editScopeRow(scopeRows.value, key, path);
}
function removeScope(key) {
  scopeRows.value = removeScopeRow(scopeRows.value, key);
}
function addScope(path) {
  scopeRows.value = appendScopeRow(scopeRows.value, path);
}
function addWorkspace(path) {
  if (workspaceDirs.value.includes(path)) return;
  workspaceDirs.value = [...workspaceDirs.value, path];
}
function removeWorkspace(path) {
  workspaceDirs.value = workspaceDirs.value.filter((dir) => dir !== path);
}
function respondFromAction({ action, comment: note }) {
  if (action === "allow" && scopeBlockReason.value) return;
  const pathActions = [...pathDraftsToActions(pathDrafts.value), ...workspaceActions(workspaceDirs.value)];
  respond(action, note, pathActions);
}
async function respond(action, comment, pathActions) {
  const response = { action };
  if (comment) response.comment = comment;
  if (pathActions && pathActions.length > 0) response.pathActions = pathActions;
  // 动过执行范围才发完整列表；没动过就不带这个字段，后端沿用申请值
  if (isSandboxAllow.value && scopeChanged(scopeRows.value, candidatePaths.value, pathOptions.value)) {
    const writePaths = scopeWritePaths(scopeRows.value, pathOptions.value);
    if (writePaths.length > 0) response.writePaths = writePaths;
  }
  await platform.session.submit(response);
  await platform.session.close();
}
async function refreshReasons() {
  reasons.value = await platform.gate.loadReasons();
}
async function saveReason(content) {
  await platform.gate.saveReason(content);
  await refreshReasons();
}
async function updateReason({ oldContent, newContent }) {
  await platform.gate.updateReason(oldContent, newContent);
  await refreshReasons();
}
async function deleteReason(content) {
  await platform.gate.deleteReason(content);
  await refreshReasons();
}

onMounted(async () => {
  const data = await platform.session.getInitData();
  cmd.value = data.command || "";
  taskId.value = data.taskId || null;
  rules.value = data.rules || [];
  envNotes.value = data.envNotes || [];
  // 旧 payload / 非 Linux 平台没有这个字段：缺就空数组，整块不渲染
  varRenders.value = data.varRenders || [];
  review.value = data.review || null;
  kind.value = data.kind || "audit";
  permission.value = data.permission || "";
  writePaths.value = data.writePaths || [];
  justification.value = data.justification || "";
  capability.value = data.capability || "";
  capabilityScope.value = data.scope || "";
  requestReason.value = data.requestReason || "";
  timeout.value = data.timeout;
  memoryMb.value = data.memoryMb || undefined;
  candidatePaths.value = data.candidatePaths || [];
  persistentRoots.value = data.persistentRoots || [];
  sessionWriteRoots.value = data.sessionWriteRoots || [];
  sessionTrustedRoots.value = data.sessionTrustedRoots || [];
  builtinRoots.value = data.builtinRoots || [];
  workspaceRoot.value = data.workspaceRoot || "";
  homeDir.value = data.homeDir || "";
  scopeRows.value = createScopeRows(candidatePaths.value);
  await refreshReasons();
  ready.value = true;
  await platform.session.markReady();
});
</script>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; background: #1a1a2e; color: #e0e0e0; }
.var-table { border-bottom: 1px solid #2a2a4a; background: #16162a; padding: 6px 16px 8px; max-height: 22vh; overflow: auto; }
.var-head { font-size: 11px; color: #7aa2f7; margin-bottom: 4px; }
.var-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; line-height: 1.9; flex-wrap: wrap; }
.var-name { color: #7aa2f7; font-family: monospace; }
.var-source { font-size: 10px; color: #888; border: 1px solid #3a3a5a; border-radius: 3px; padding: 0 4px; }
.var-value { color: #4ec9b0; font-family: monospace; word-break: break-all; }
.var-reason { color: #b0b0b0; font-size: 11px; }
.var-kind { font-size: 10px; color: #666; }
.var-row-unknown .var-name { color: #9a9ab0; }
</style>
