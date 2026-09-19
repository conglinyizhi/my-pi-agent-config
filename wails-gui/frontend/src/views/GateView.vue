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
      :current="cur"
      @update:current="cur = $event"
    />

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
      :path-drafts="pathDrafts"
      :verdict-meta="verdictMeta"
      @stage-path="stagePath"
      @cancel-path="cancelPath"
    />

    <GateActionBar
      :is-sandbox-allow="isSandboxAllow"
      :is-capability="isCapability"
      :reasons="reasons"
      :comment="comment"
      :path-draft-summary="draftSummary"
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
import { cancelPathAuthorization, cyclePathDraft, pathDraftsToActions, pathDraftSummary } from "../domain/gate/path-actions.js";
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
const pathDrafts = ref({});

const cur = ref(0);
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
const pathRoots = computed(() => ({
  persistentRoots: persistentRoots.value,
  sessionTrustedRoots: sessionTrustedRoots.value,
  sessionWriteRoots: sessionWriteRoots.value,
  builtinRoots: builtinRoots.value,
  workspaceRoot: workspaceRoot.value,
}));
const draftSummary = computed(() => pathDraftSummary(pathDrafts.value));

function stagePath({ path, list }) {
  pathDrafts.value = cyclePathDraft(pathDrafts.value, path, list, pathRoots.value);
}
function cancelPath(path) {
  pathDrafts.value = cancelPathAuthorization(pathDrafts.value, path, pathRoots.value);
}
function respondFromAction({ action, comment: note }) {
  respond(action, note, pathDraftsToActions(pathDrafts.value));
}
async function respond(action, comment, pathActions) {
  const response = { action };
  if (comment) response.comment = comment;
  if (pathActions && pathActions.length > 0) response.pathActions = pathActions;
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
  await refreshReasons();
  ready.value = true;
  await platform.session.markReady();
});
</script>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; background: #1a1a2e; color: #e0e0e0; }
</style>
