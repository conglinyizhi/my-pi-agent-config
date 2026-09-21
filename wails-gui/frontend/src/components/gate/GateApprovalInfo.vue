<template>
  <div class="gate-fragment">
    <div class="decision-summary" :class="`decision-${decisionSummary.tone}`">
      <strong>{{ decisionSummary.label }}</strong>
      <span>{{ decisionSummary.text }}</span>
    </div>

    <div v-if="isCapability" class="sa-info capability-info">
      <div class="sa-row"><span class="sa-label">能力</span><span>{{ capability }}</span></div>
      <div class="sa-row"><span class="sa-label">范围</span><span>{{ capabilityScope }}</span></div>
      <div v-if="requestReason" class="sa-row"><span class="sa-label">理由</span><span class="sa-justification">{{ requestReason }}</span></div>
      <div class="sa-row"><span class="sa-label">说明</span><span>只批准当前这条命令；worker 会在批准后重新启动，不会获得持续权限。</span></div>
    </div>

    <div v-if="isSandboxAllow" class="sa-info">
      <div v-if="justification" class="sa-row">
        <span class="sa-label">理由</span>
        <span class="sa-justification">{{ justification }}</span>
      </div>
      <div v-if="writePaths.length" class="sa-row">
        <span class="sa-label">额外可写</span>
        <span class="sa-paths"><code v-for="path in writePaths" :key="path" class="sa-path">{{ path }}</code></span>
      </div>
      <div class="sa-row">
        <span class="sa-label">执行时限</span>
        <span>{{ timeout === undefined ? '默认' : `${timeout} 秒` }}（仅批准后生效）</span>
      </div>
      <div class="sa-row">
        <span class="sa-label">内存上限</span>
        <span>{{ memoryMb === undefined ? `默认 1GiB（${defaultMemoryMb} MB）` : `${memoryMb} MB` }}（超出即终止进程组）</span>
      </div>
    </div>

    <div v-if="isSandboxAllow && permission === 'full-access'" class="sandbox-warning">
      <strong>🔴 完全取消文件系统沙箱</strong>
      <span>本次命令可读写当前用户本来有权限访问的任意路径；这不是“额外开放某个目录”。</span>
    </div>
    <div v-if="isSandboxAllow && rules.length" class="sandbox-risk">
      <div class="paths-header">⚠️ 命令审计命中 {{ rules.length }} 项</div>
      <div v-for="(rule, index) in rules" :key="index" class="rule-row">
        <code class="rule-pattern">{{ rule.name }}</code>
        <span v-if="rule.matched && rule.matched.length" class="rule-matched">{{ rule.matched.join(' ') }}</span>
        <span class="rule-tip">{{ rule.tip }}</span>
      </div>
    </div>

    <div v-if="!isSandboxAllow && !isCapability && review" class="review-block">
      <div class="review-header">
        🤖 云端模型审核
        <span class="verdict-badge" :class="verdictMeta.cls">{{ verdictMeta.label }}</span>
      </div>
      <div v-if="review.reason" class="review-reason">{{ review.reason }}</div>
      <div v-if="review.suggestion" class="review-suggestion">💡 {{ review.suggestion }}</div>
      <div v-if="review.opinion" class="review-opinion">{{ review.opinion }}</div>
    </div>

    <div v-if="!isSandboxAllow && !isCapability" @click="showRules = !showRules" class="collapse-header" title="点击展开/收起规则">
      {{ showRules ? '▼' : '▶' }} {{ rules.length }} 条规则匹配
    </div>
    <div v-if="!isSandboxAllow && !isCapability && showRules" class="collapse-body">
      <div v-for="(rule, index) in rules" :key="index" class="rule-row">
        <code class="rule-pattern">{{ rule.name }}</code>
        <span v-if="rule.matched && rule.matched.length" class="rule-matched">{{ rule.matched.join(' ') }}</span>
        <span class="rule-tip">{{ rule.tip }}</span>
      </div>
    </div>

    <div v-if="isSandboxAllow && permission === 'write-paths' && rules.length === 0 && scopeRows.length" class="paths-block">
      <div class="paths-header">
        📁 执行范围与目录授权
        <span class="paths-sub">（可改本次执行范围；随允许/拒绝一并提交）</span>
      </div>

      <div v-for="row in scopeModels" :key="row.key" class="path-item">
        <div class="path-row" :class="{ pending: row.trust && row.trust.pending, locked: row.trust && row.trust.locked, invalid: !row.guard.ok }">
          <input
            class="path-edit"
            data-name="path-edit"
            spellcheck="false"
            :value="row.input"
            :title="row.guard.ok ? `本次执行范围：${row.path}` : row.guard.reason"
            @input="editScope(row.key, $event)"
          >
          <span class="path-state" :class="{ pending: row.trust && row.trust.pending, locked: row.trust && row.trust.locked }">{{ row.label }}</span>
          <template v-if="row.trustable && row.trust && !row.trust.locked">
            <button
              v-if="row.trust.showPersistent"
              data-name="path-persistent"
              :class="['btn', 'btn-allow', 'btn-sm', { pending: row.trust.persistentPending }]"
              title="标记为长期可写；命中后 sandbox-allow 可免审批。再次点击清除这条暂存。"
              @click="stagePath(row.path, 'allow')"
            >长期信任</button>
            <button
              v-if="row.trust.showSession"
              data-name="path-session-trust"
              :class="['btn', 'btn-trust', 'btn-sm', { pending: row.trust.sessionPending }]"
              title="标记为本 session 可写并可免审批。再次点击清除这条暂存。"
              @click="stagePath(row.path, 'session-trust')"
            >本 session 信任</button>
            <button
              data-name="path-block"
              :class="['btn', 'btn-deny', 'btn-sm', { pending: row.trust.blockPending }]"
              title="标记为黑名单。再次点击清除这条暂存。"
              @click="stagePath(row.path, 'block')"
            >黑名单</button>
            <button
              v-if="row.trust.cancelLabel"
              data-name="path-cancel"
              class="btn btn-cancel btn-sm"
              :title="row.trust.cancelLabel === '取消授权' ? '提交时撤销该目录已有的长期/本 session 授权' : '清除这条暂存标记'"
              @click="cancelPath(row.path)"
            >{{ row.trust.cancelLabel }}</button>
          </template>
          <button
            v-if="row.guard.ok && !(row.trust && row.trust.locked)"
            data-name="path-workspace"
            class="btn btn-trust btn-sm"
            title="把这个目录设为副工作区（长期信任，任意目录；提交前再确认一次）"
            @click="requestWorkspace(row.path)"
          >设为副工作区</button>
          <button data-name="path-remove" class="btn btn-cancel btn-sm" title="从本次执行范围里去掉这一行" @click="removeScope(row.key)">移除</button>
        </div>
        <div v-if="!row.guard.ok" class="path-warn">⚠ {{ row.guard.reason }}</div>
        <div v-else-if="!row.trustable" class="path-note">
          {{ row.added ? '新增的执行路径' : '已改动的执行范围' }}：长期/本 session 授权的判定基准仍是原始候选 {{ row.candidate }}，要长期信任这个目录请用「设为副工作区」。
        </div>
      </div>

      <div class="path-row path-add-row">
        <input
          v-model="newScopePath"
          class="path-edit"
          data-name="scope-add-input"
          spellcheck="false"
          placeholder="增加一条执行路径（须与原始候选互为父/子目录）"
          @keydown.enter.prevent="addScope"
        >
        <button data-name="scope-add" class="btn btn-trust btn-sm" :disabled="!newScopeGuard.ok" @click="addScope">增加</button>
      </div>
      <div v-if="newScopePath.trim() && !newScopeGuard.ok" class="path-warn">⚠ {{ newScopeGuard.reason }}</div>

      <div class="workspace-block">
        <div class="paths-header">
          🗂 副工作区（长期信任）
          <span class="paths-sub">（任意目录，一次可给多个；授予后该目录及子目录的写操作完全免审）</span>
        </div>
        <div v-for="dir in workspaceDirs" :key="dir" class="path-row workspace-row">
          <code class="path-dir">{{ dir }}</code>
          <span class="path-state locked">已加入</span>
          <button data-name="workspace-remove" class="btn btn-cancel btn-sm" title="去掉这条待提交的副工作区" @click="removeWorkspace(dir)">移除</button>
        </div>
        <div class="path-row path-add-row">
          <input
            v-model="newWorkspacePath"
            class="path-edit"
            data-name="workspace-add-input"
            spellcheck="false"
            placeholder="任意目录，例如 ~/disk/ai_workspace"
            @keydown.enter.prevent="requestWorkspace(newWorkspacePath)"
          >
          <button
            data-name="workspace-add"
            class="btn btn-trust btn-sm"
            :disabled="!workspaceGuard.ok || workspaceDuplicate"
            title="设为副工作区：提交前会再确认一次"
            @click="requestWorkspace(newWorkspacePath)"
          >设为副工作区</button>
        </div>
        <div v-if="newWorkspacePath.trim() && !workspaceGuard.ok" class="path-warn">⚠ {{ workspaceGuard.reason }}</div>
        <div v-else-if="workspaceDuplicate" class="path-note">这个目录已经在该列表里了。</div>
        <div v-if="pendingWorkspace" class="workspace-confirm">
          <span>确认把 <code class="path-dir inline">{{ pendingWorkspace }}</code> 设为副工作区？该目录及子目录后续的写操作不再弹审批。</span>
          <button data-name="workspace-confirm" class="btn btn-allow btn-sm" @click="confirmWorkspace">确认授予</button>
          <button data-name="workspace-cancel" class="btn btn-cancel btn-sm" @click="pendingWorkspace = null">取消</button>
        </div>
      </div>

      <div v-if="scopeIssueCount" class="path-warn">⚠ {{ scopeIssueCount }} 行执行路径没通过护栅，先修正再点允许（后端也会再验一遍）。</div>
      <div class="paths-hint">执行范围改动随允许/拒绝一起提交，只认原始候选的父/子目录；灰色行是工作区或 /tmp 这类已经默认可写的目录，不能在这里取消。</div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from "vue";
import { checkScopeEdit, checkWorkspacePath, scopeRowModel } from "../../domain/gate/path-actions.js";
import { gateDecisionSummary } from "../../domain/gate/summary.js";

const props = defineProps({
  isSandboxAllow: Boolean,
  isCapability: Boolean,
  permission: { type: String, default: "" },
  writePaths: { type: Array, default: () => [] },
  justification: { type: String, default: "" },
  capability: { type: String, default: "" },
  capabilityScope: { type: String, default: "" },
  requestReason: { type: String, default: "" },
  timeout: { type: [Number, String], default: undefined },
  memoryMb: { type: [Number, String], default: undefined },
  rules: { type: Array, default: () => [] },
  review: { type: Object, default: null },
  candidatePaths: { type: Array, default: () => [] },
  persistentRoots: { type: Array, default: () => [] },
  sessionWriteRoots: { type: Array, default: () => [] },
  sessionTrustedRoots: { type: Array, default: () => [] },
  builtinRoots: { type: Array, default: () => [] },
  workspaceRoot: { type: String, default: "" },
  // 家目录绝对路径：副工作区护栅用它挡家目录根本身
  homeDir: { type: String, default: "" },
  // 执行范围行（candidate + 可编辑 path）与待提交的副工作区列表，状态在 GateView
  scopeRows: { type: Array, default: () => [] },
  workspaceDirs: { type: Array, default: () => [] },
  pathDrafts: { type: Object, default: () => ({}) },
  verdictMeta: { type: Object, required: true },
  defaultMemoryMb: { type: Number, default: 1024 },
});

const emit = defineEmits(["stage-path", "cancel-path", "edit-scope", "remove-scope", "add-scope", "add-workspace", "remove-workspace"]);
const showRules = ref(false);
const decisionSummary = computed(() => gateDecisionSummary({
  kind: props.isCapability ? "capability" : props.isSandboxAllow ? "sandbox-allow" : "audit",
  permission: props.permission,
  capability: props.capability,
  rules: props.rules,
  review: props.review,
}));
const pathRoots = computed(() => ({
  persistentRoots: props.persistentRoots,
  sessionTrustedRoots: props.sessionTrustedRoots,
  sessionWriteRoots: props.sessionWriteRoots,
  builtinRoots: props.builtinRoots,
  workspaceRoot: props.workspaceRoot,
}));

const pathOptions = computed(() => ({ homeDir: props.homeDir, workspaceRoot: props.workspaceRoot }));
const scopeModels = computed(() => props.scopeRows.map((row) => scopeRowModel(row, props.candidatePaths, {
  ...pathOptions.value,
  roots: pathRoots.value,
  drafts: props.pathDrafts,
})));
const scopeIssueCount = computed(() => scopeModels.value.filter((row) => !row.guard.ok).length);
const newScopePath = ref("");
const newScopeGuard = computed(() => checkScopeEdit(newScopePath.value, props.candidatePaths, pathOptions.value));
const newWorkspacePath = ref("");
const pendingWorkspace = ref(null);
const workspaceGuard = computed(() => checkWorkspacePath(newWorkspacePath.value, pathOptions.value));
const workspaceDuplicate = computed(() => workspaceGuard.value.ok && props.workspaceDirs.includes(workspaceGuard.value.path));

function stagePath(path, list) {
  emit("stage-path", { path, list });
}
function cancelPath(path) {
  emit("cancel-path", path);
}
function editScope(key, event) {
  emit("edit-scope", { key, path: event.target.value });
}
function removeScope(key) {
  emit("remove-scope", key);
}
function addScope() {
  if (!newScopeGuard.value.ok) return;
  emit("add-scope", newScopeGuard.value.path);
  newScopePath.value = "";
}
// 「设为副工作区」是持久授权：先落到输入框，再走一次二次确认才 emit
function requestWorkspace(target) {
  const text = typeof target === "string" && target ? target : newWorkspacePath.value;
  newWorkspacePath.value = text;
  const guard = checkWorkspacePath(text, pathOptions.value);
  if (!guard.ok || props.workspaceDirs.includes(guard.path)) {
    pendingWorkspace.value = null;
    return;
  }
  pendingWorkspace.value = guard.path;
}
function confirmWorkspace() {
  if (!pendingWorkspace.value) return;
  emit("add-workspace", pendingWorkspace.value);
  pendingWorkspace.value = null;
  newWorkspacePath.value = "";
}
function removeWorkspace(path) {
  emit("remove-workspace", path);
}
</script>

<style scoped>
.decision-summary { padding: 8px 16px; border-top: 1px solid #2a2a4a; display: flex; flex-direction: column; gap: 3px; font-size: 12px; line-height: 1.5; }
.decision-summary strong { font-size: 11px; }
.decision-info { background: #131328; color: #a9b1d6; }
.decision-warning { background: #2a1a0a; color: #f0c674; }
.decision-danger { background: #3a1a1a; color: #ffb4b4; }
.sa-info { padding: 10px 16px; border-top: 1px solid #2a2a4a; display: flex; flex-direction: column; gap: 8px; }
.sa-row { display: flex; gap: 10px; align-items: baseline; }
.sa-label { flex-shrink: 0; font-size: 11px; color: #888; }
.sa-justification { font-size: 13px; color: #e0e0e0; line-height: 1.6; }
.sa-paths { display: flex; flex-wrap: wrap; gap: 6px; }
.sa-path { color: #7aa2f7; background: #1a1a3e; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 12px; }
.path-state { flex-shrink: 0; color: #aaa; font-size: 11px; }
.path-state.pending { color: #f0c674; }
.path-state.locked { color: #666; }
.path-row.pending { background: #1c1c32; border-radius: 4px; padding: 4px 6px; }
.path-row.locked { opacity: 0.72; }
.path-row.locked .path-dir { color: #888; }
.btn-trust { color: #c792ea; background: #241b32; border-color: #c792ea55; }
.btn.pending { outline: 1px solid currentColor; filter: brightness(1.15); }
.sandbox-warning { padding: 10px 16px; border-top: 1px solid #ff6b6b55; background: #3a1a1a; color: #ffb4b4; display: flex; flex-direction: column; gap: 4px; font-size: 12px; line-height: 1.5; }
.sandbox-risk { padding: 8px 16px; border-top: 1px solid #e67e2255; background: #2a1a0a; }
.paths-block { padding: 8px 16px; border-top: 1px solid #2a2a4a; background: #14142a; }
.paths-header { font-size: 12px; color: #7aa2f7; margin-bottom: 6px; }
.paths-sub { color: #888; font-size: 11px; }
.path-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.path-dir { flex: 1; color: #e0e0e0; background: #0d0d1a; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 12px; word-break: break-all; }
.paths-hint { font-size: 11px; color: #666; margin-top: 4px; }
.btn-sm { padding: 2px 8px; font-size: 11px; }
.path-item { padding: 2px 0; }
.path-row.invalid { border-left: 2px solid #e74c3c55; border-radius: 3px; padding-left: 4px; }
.path-edit { flex: 1 1 auto; min-width: 0; color: #e0e0e0; background: #0d0d1a; border: 1px solid #2a2a4a; border-radius: 3px; padding: 3px 6px; font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 12px; }
.path-edit:focus { outline: none; border-color: #4ec9b0; }
.path-add-row { margin-top: 4px; }
.path-add-row .path-edit { color: #a9b1d6; }
.path-warn { font-size: 11px; color: #e67e22; margin: 2px 0 4px; line-height: 1.5; }
.path-note { font-size: 11px; color: #666; margin: 2px 0 4px; line-height: 1.5; }
.workspace-block { margin-top: 10px; padding-top: 8px; border-top: 1px dashed #2a2a4a; }
.workspace-confirm { margin-top: 6px; padding: 6px 8px; background: #0d0d1a; border: 1px solid #f0c67455; border-radius: 4px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 11.5px; color: #f0c674; line-height: 1.6; }
.path-dir.inline { flex: none; display: inline; padding: 1px 4px; }
.btn:disabled { opacity: 0.45; cursor: not-allowed; filter: none; }
.review-block { padding: 8px 16px; border-top: 1px solid #2a2a4a; background: #131328; }
.review-header { font-size: 12px; color: #7aa2f7; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
.verdict-badge { font-size: 11px; padding: 1px 8px; border-radius: 3px; }
.verdict-badge.v-safe { color: #7ee787; background: #12261a; border: 1px solid #7ee78744; }
.verdict-badge.v-risky { color: #e67e22; background: #2a1a0a; border: 1px solid #e67e2255; }
.verdict-badge.v-dangerous { color: #ff6b6b; background: #3a1a1a; border: 1px solid #ff6b6b55; }
.verdict-badge.v-error { color: #999; background: #1a1a2e; border: 1px solid #444; }
.review-reason { font-size: 13px; color: #e0e0e0; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.review-suggestion { font-size: 12px; color: #7aa2f7; margin-top: 3px; }
.review-opinion { margin-top: 6px; padding: 6px 10px; background: #0d0d1a; border-left: 2px solid #7aa2f7; border-radius: 3px; font-size: 12.5px; color: #d0d0e0; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.rule-row { padding: 3px 6px; margin-bottom: 2px; border-left: 2px solid #ff6b6b44; display: flex; gap: 6px; }
.rule-pattern { color: #ce9178; background: #0d0d1a; padding: 1px 4px; border-radius: 2px; }
.rule-matched { color: #e67e22; background: #2a1a0a; padding: 1px 4px; border-radius: 2px; font-family: monospace; font-size: 11px; }
.rule-tip { color: #999; }
</style>

<style scoped>
.gate-fragment { display: contents; }
</style>
