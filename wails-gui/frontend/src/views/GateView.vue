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
      :verdict-meta="verdictMeta"
      @path-action="pathAction"
    />

    <GateActionBar
      :is-sandbox-allow="isSandboxAllow"
      :is-capability="isCapability"
      :rules="rules"
      :reasons="reasons"
      @respond="respondFromAction"
      @save-reason="saveReason"
    />
  </div>
</template>

<script setup>
import "../gui-theme.css";
import { computed, onMounted, ref } from "vue";
import { usePlatform } from "../platform/index.js";
import { findHighlights } from "../domain/gate/highlights.js";
import GateActionBar from "../components/gate/GateActionBar.vue";
import GateApprovalInfo from "../components/gate/GateApprovalInfo.vue";
import GateCommandPreview from "../components/gate/GateCommandPreview.vue";

const platform = usePlatform();

const ready = ref(false);
const cmd = ref("");
const taskId = ref(null);
const rules = ref([]);
// 云端模型审核意见（audit：verdict/reason/suggestion/opinion）
const review = ref(null);
// sandbox-allow 升权审批字段（kind=sandbox-allow 时启用）
const kind = ref("");
const permission = ref("");
const writePaths = ref([]);
const justification = ref("");
const capability = ref("");
const capabilityScope = ref("");
const requestReason = ref("");
const timeout = ref(undefined);
const memoryMb = ref(undefined);
const DEFAULT_MEMORY_MB = 1024;
// 目录白/黑名单候选（writePaths + 命令路径）
const candidatePaths = ref([]);
const persistentRoots = ref([]);
const sessionWriteRoots = ref([]);
const sessionTrustedRoots = ref([]);

const cur = ref(0);
const reasons = ref([]);

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

function pathAction({ path, list }) {
  // 选择目录授权并结束本次审核；授权动作同时放行当前命令链。
  respond(list === "block" ? "deny" : "allow", undefined, undefined, [{ path, list }]);
}
function respondFromAction({ action, comment, flagged, pathActions }) {
  respond(action, comment, flagged, pathActions);
}
async function respond(action, comment, flagged, pathActions) {
  const response = { action };
  if (comment) response.comment = comment;
  if (flagged && flagged.length > 0) response.flagged = flagged;
  if (pathActions && pathActions.length > 0) response.pathActions = pathActions;
  await platform.session.submit(response);
  await platform.session.close();
}
async function saveReason(content) {
  await platform.gate.saveReason(content);
  reasons.value = await platform.gate.loadReasons();
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
  reasons.value = await platform.gate.loadReasons();
  ready.value = true;
  await platform.session.markReady();
  // 子组件在 ready 后挂载并定位第一个高亮点。
  // 不设自动超时：用户考虑多久都行；扩展侧有 1 小时兑底，关窗口（X）也会让扩展回退 TUI。
});
</script>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; background: #1a1a2e; color: #e0e0e0; }
</style>
