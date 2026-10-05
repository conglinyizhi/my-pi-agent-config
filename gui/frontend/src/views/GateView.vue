<template>
  <div v-if="ready" class="app" :class="{ 'has-review': !isSandboxAllow && !isCapability }">
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
      :issue-lines="issueLines"
      :env-notes="envNotes"
      :var-renders="varRenders"
      :edit-calls="editCalls"
      :color-lang="isScript ? 'javascript' : ''"
      :current="cur"
      @update:current="cur = $event"
    />

    <div v-if="effectRows.length" data-name="script-effects" class="effects">
      <div class="effects-head">📋 静态扫描（只认字面量，看不清的地方已标出）</div>
      <div
        v-for="section in effectRows"
        :key="section.key"
        class="effect-row"
        :class="{ 'effect-warn': section.warn }"
      >
        <span class="effect-label">{{ section.label }}</span>
        <span class="effect-items">{{ section.items.join("、") }}</span>
      </div>
    </div>

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
import { digestLine, effectSectionsOf, isScriptAudit, scriptAuditTitle } from "../domain/gate/script-audit.js";
import { varRenderRows } from "../domain/gate/var-renders.js";
import { cancelPathAuthorization, createScopeRows, cyclePathDraft, editScopeRow, appendScopeRow, pathDraftsToActions, pathDraftSummary, removeScopeRow, scopeChanged, scopeIssues, scopeWritePaths, workspaceActions } from "../domain/gate/path-actions.js";
import GateActionBar from "../components/gate/GateActionBar.vue";
import GateApprovalInfo from "../components/gate/GateApprovalInfo.vue";
import GateCommandPreview from "../components/gate/GateCommandPreview.vue";
import OpenInEditorMenu from "../components/gate/OpenInEditorMenu.vue";

const platform = usePlatform();

const ready = ref(false);
const cmd = ref("");
const taskId = ref(null);
const rules = ref([]);
const review = ref(null);
const kind = ref("");
/** 受审对象形态：script = run_code 的脚本事前审核 */
const subject = ref("");
/** 结构化影响面（pi 侧算好）：工具 / 路径 / 命令 / 看不清的地方 */
const scriptEffects = ref(null);
/** 要折成芯片的调用（影响面里带过来的显示层事实） */
const editCalls = ref([]);
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
/** 脚本事前审核：标题、影响面分区、摘要行都换成这一套 */
const isScript = computed(() => isScriptAudit({ subject: subject.value }));
const title = computed(() =>
  isScript.value
    ? scriptAuditTitle()
    : isSandboxAllow.value ? "🔓 跨沙箱请求（仅此一次）" : isCapability.value ? "🔐 subagent 能力请求" : "⚠️ 危险命令审计",
);
/** 同文件改动合并出来的净变化（显示层推演，pi 侧算好） */
// 「同文件改动合并」按提督说的删了：日常用不到，占地方

/** 出问题的行号：静态扫描里"看不清"的条目以 `行:列` 开头，取出来给代码区行号栏标黄 */
// 代码区不再按扫描的行号标黄：扫描那份文本与显示那份不是同一份，标出来经常是错行
// （踩过：标在空白行上）。等两边的行号口径统一了再打开。
const issueLines = computed(() => []);
const effectRows = computed(() => effectSectionsOf(scriptEffects.value));
const permLabel = computed(() =>
  permission.value === "full-access" ? "完全取消沙箱" : "保持沙箱 + 额外可写",
);
const verdictMeta = computed(() => {
  const verdict = review.value?.verdict;
  if (verdict === "safe") return { label: "✅ 安全", cls: "v-safe" };
  if (verdict === "risky") return { label: "⚠️ 有风险", cls: "v-risky" };
  if (verdict === "dangerous") return { label: "🔴 危险", cls: "v-dangerous" };
  return { label: "寄了", cls: "v-error" };
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
  subject.value = data.subject || "";
  scriptEffects.value = data.scriptEffects || null;
  editCalls.value = data.scriptEffects?.editCalls || [];
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
/* ── 版式：紧凑、不滚、左右打通 ──────────────────────────────
   这是一扇"对话框"，不是应用：一屏之内摆下尽量多的信息。
   所以小圆角（6px）、小内边距、块间 6px 缝；要横向空间的（指令、底栏）横跨整宽，
   模型审核分上下两张卡挂右栏（上=大模型，中=System One）。
   每块自己设上限并在内部滚动，页面整体不滚。左列只钉判定摘要一格：
   块是条件出现的，钉死行号一旦缺块就整条串位（踩过）。 */
.app {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  height: 100vh;
  overflow: auto;
  background: #11141a;
  color: #dfe3ea;
  font: 12px/1.55 system-ui, sans-serif;
}
.app.has-review {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
  /* 五条轨道：header / LLM 行 / System One 行 / 图例行 / 之后按内容。
     中间两条给 1fr，剩余高度由它们分掉——代码区就吃这份，整页不出滚动条。 */
  grid-template-rows: auto minmax(min-content, 1fr) minmax(min-content, 1fr) auto;
  grid-auto-rows: min-content;
  grid-auto-flow: row dense;
  align-content: start;
  /* 放不下时宁可整页滚一点，也不让块被底栏压住（sticky 那版就是压住了内容） */
  overflow: auto;
}
/* 平铺：块不铺底、不浮起，只用发丝线分界，全部落在同一个面上。
   块默认整宽；第 1 行 header 整宽，第 2-3 行左=代码区、右=LLM 意见 / System One 决策，
   之后静态扫描结果与底栏整宽。 */
.app.has-review > *,
.app :deep(.gate-fragment > *) {
  grid-column: 1 / -1;
  background: transparent;
  border: 1px solid #232833;
  border-radius: 3px;
  padding: 5px 9px;
}
.app.has-review :deep(.decision-summary) { grid-area: 4 / 2 / 5 / 3; align-self: start; padding: 6px 10px 6px 8px; border-left-width: 3px; }
.app :deep(.decision-summary.decision-deny) { border-left-color: #ff6b6b; }
.app :deep(.decision-summary.decision-warn) { border-left-color: #e6a23c; }
.app :deep(.decision-summary.decision-allow) { border-left-color: #4ec9b0; }
/* header 整宽：标题 + 上一个/下一个 */
.app.has-review :deep(.top-bar) {
  grid-area: 1 / 1 / 2 / -1;
  padding: 6px 10px;
}
/* 代码区：占左列第 2-3 行，全窗唯一允许出滚动条的地方 */
.app.has-review :deep(.cmd-wrap) {
  grid-area: 2 / 1 / 4 / 2;
  background: #0d1014;
  padding: 0;
  min-height: 110px;
  overflow: auto;
}
.app.has-review :deep(.fold-legend) {
  grid-area: 4 / 1 / 5 / 2;
  padding: 4px 10px;
}
/* 右栏两块：上=LLM 意见，中=System One 决策。按内容走，不出滚动条 */
.app.has-review :deep(.model-card) { align-self: stretch; overflow: visible; }
.app.has-review :deep(.model-card[data-model="chat"]) { grid-area: 2 / 2 / 3 / 3; }
.app.has-review :deep(.model-card[data-model="system1"]) { grid-area: 3 / 2 / 4 / 3; }
/* 卡头文字跟着判定灯一起变色。配色必须写在这一侧：子组件里的 .tone-* 拼不过
   这条 :deep() 的特异性，写在那边等于没写（踩过） */
.app.has-review :deep(.model-head.tone-ok) { color: #4ec9b0; }
.app.has-review :deep(.model-head.tone-warn) { color: #e6a23c; }
.app.has-review :deep(.model-head.tone-bad) { color: #ff6b6b; }
.app.has-review :deep(.model-head) {
  font-size: 11px;
  color: #8ea2c8;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 6px;
}
/* 计数与灯跟在标题同一行、贴右；不许断开（栏窄时宁可挤，也不要把数字断成两半） */
.app.has-review :deep(.weight-count) { margin-left: auto; white-space: nowrap; }
/* 底栏：整宽，占自己一行。不 sticky——它一浮起来就会盖住下面那块 */
.app :deep(.actions),
.app.has-review :deep(.actions) {
  grid-column: 1 / -1;
  background: #151922;
  border-color: #2b3140;
}
/* 图例与"需要人工判断"都去掉：图形界面上点击交互已经够显眼，不用再用文字教一遍 */
.app.has-review :deep(.fold-legend),
.app.has-review :deep(.decision-summary) { display: none; }
/* System One 决策模型意见：细行，名称在左、置信度在右，风险条做成底边染色 */
.app.has-review :deep(.weight-row) {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 8px;
  border-top: 0;
  border-bottom: 1px solid #232833;
  padding: 3px 0 4px;
  font-size: 11.5px;
}
.app.has-review :deep(.weight-row)::after {
  content: "";
  position: absolute;
  left: 0;
  bottom: -1px;
  height: 2px;
  width: var(--w, 0%);
  background: #3f4c66;
  border-radius: 1px;
}
.app.has-review :deep(.weight-row.flagged)::after { background: #e6a23c; }
.app.has-review :deep(.weight-row.disabled)::after { background: transparent; }
.app.has-review :deep(.weight-label) { min-width: 92px; padding-left: 6px; }
.app.has-review :deep(.weight-conf) { margin-left: auto; color: #9aa3b2; }
/* 名称 + 置信度就够；条宽已经画在底边，阈值与原始值进 title */
.app.has-review :deep(.weight-bar),
.app.has-review :deep(.weight-risk),
.app.has-review :deep(.weight-threshold),
.app.has-review :deep(.weight-raw) { display: none; }
/* 解析结果给一个宽松上限：正常窗口下按内容走（不滚），只有窗口很矮时才自己滚，
   这样底栏不会被推到屏幕外——按钮够得着比"绝对不滚"更重要 */
.app.has-review > .merged { max-height: 22vh; overflow: auto; }
.app.has-review > .effects { max-height: 26vh; overflow: auto; }
.app.has-review > .var-table { max-height: 18vh; overflow: auto; }
/* System One 决策区：名称在左、数值在右，行间发丝线 */
.app.has-review :deep(.weight-row) { border-top: 1px solid #232833; padding: 3px 0; font-size: 11.5px; }
.app.has-review :deep(.weight-row:first-of-type) { border-top: 0; }
.app.has-review :deep(.weight-table) { padding: 2px 0 0; }
.var-table { border-bottom: 1px solid #2a2a4a; background: #16162a; padding: 6px 16px 8px; max-height: 22vh; overflow: auto; }
.var-head { font-size: 11px; color: #7aa2f7; margin-bottom: 4px; }
.var-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; line-height: 1.9; flex-wrap: wrap; }
.var-name { color: #7aa2f7; font-family: monospace; }
.var-source { font-size: 10px; color: #888; border: 1px solid #3a3a5a; border-radius: 3px; padding: 0 4px; }
.var-value { color: #4ec9b0; font-family: monospace; word-break: break-all; }
.var-reason { color: #b0b0b0; font-size: 11px; }
.var-kind { font-size: 10px; color: #666; }
.var-row-unknown .var-name { color: #9a9ab0; }
.effects { border-bottom: 1px solid #2a2a4a; background: #141428; padding: 6px 16px 8px; max-height: 26vh; overflow: auto; }
.effects-head { font-size: 11px; color: #7aa2f7; margin-bottom: 4px; }
.effect-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; line-height: 1.9; flex-wrap: wrap; }
.effect-label { flex: 0 0 auto; color: #888; font-size: 11px; }
.effect-items { color: #cfcfcf; font-family: monospace; word-break: break-all; }
.effect-warn .effect-label { color: #e0af68; }
.effect-warn .effect-items { color: #e0af68; }
.effects-digest { margin-top: 4px; font-size: 10px; color: #666; font-family: monospace; }
/* 合并视图：同一文件的净变化，断链/基准不明的一眼看得出 */
.merged { padding: 8px 16px; border-top: 1px solid #2a2a4a; background: #10101f; max-height: 40vh; overflow: auto; }
.merged-head { font-size: 12px; color: #9aa4bf; margin-bottom: 6px; }
.merged-item { margin-bottom: 10px; }
.merged-title { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.merged-path { color: #c0caf5; }
.merged-item.merged-warn .merged-path { color: #e6a23c; }
.merged-badge { color: #7aa2f7; }
.merged-badge-none { color: #e6a23c; }
.merged-count { color: #888; font-family: monospace; }
.merged-note { color: #e6a23c; font-size: 11px; }
.merged-reason { font-size: 11px; color: #e6a23c; margin: 2px 0 4px; }
</style>
