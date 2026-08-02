<template>
  <div v-if="ready" class="app">
    <!-- 左侧列表 -->
    <aside class="sidebar">
      <header class="sidebar-header">
        <h1>⚓ 任务确认</h1>
        <div class="task-count">{{ texts.length }} 个任务</div>
      </header>
      <div class="task-list">
        <div v-for="(t, i) in texts" :key="i" @click="select(i)" :class="['task-item', { active: selectedIdx===i }]">
          <span :style="{color: statusColor(states[i].status)}" class="task-dot">{{ statusIcon(states[i].status) }}</span>
          <span class="task-name">{{ previewTitle(i) }}</span>
        </div>
      </div>
    </aside>

    <!-- 右侧详情 -->
    <main class="detail">
      <template v-if="selectedIdx !== null">
        <header class="detail-header">
          <span class="detail-label">任务 {{ selectedIdx + 1 }} / {{ texts.length }}</span>
          <span v-if="texts.length>1" class="nav-hint">◀▶ 点击左侧切换</span>
        </header>

        <div v-if="mode==='view'" class="detail-body">
          <div v-for="f in fields" :key="f.key" class="field">
            <label>{{ f.label }}</label>
            <pre>{{ f.value || '(未识别)' }}</pre>
          </div>
        </div>

        <div v-if="mode==='edit'" class="detail-body edit-mode">
          <label class="edit-label">编辑任务 {{ selectedIdx+1 }} 的描述（保持格式）</label>
          <textarea v-model="editText" class="edit-area"></textarea>
        </div>
      </template>
      <div v-else class="empty-detail">选择左侧任务查看详情</div>

      <footer v-if="selectedIdx !== null && mode==='view'" class="actions">
        <button @click="setState('feedback')" data-name="action-feedback" class="btn btn-warn">💬 退回重译</button>
        <button @click="mode='edit';editText=texts[selectedIdx]" data-name="action-edit" class="btn btn-edit">✏️ 修改</button>
        <button @click="setState('approved')" data-name="action-approve" class="btn btn-allow">✅ 通过</button>
      </footer>

      <footer v-if="selectedIdx !== null && mode==='edit'" class="actions">
        <button @click="mode='view'" class="btn btn-cancel">取消</button>
        <button @click="submitEdit" data-name="action-submit-edit" class="btn btn-allow">✅ 提交修改</button>
      </footer>

      <footer v-if="allReviewed" class="approve-bar">
        <button @click="approveAll" data-name="action-approve-all" class="btn btn-allow btn-full">✅ 全部确认（{{ approvedCount }}/{{ texts.length }}）</button>
      </footer>
      <footer v-else class="progress-bar">
        <span>审核进度：{{ approvedCount }}/{{ texts.length }}</span>
      </footer>
    </main>

    <!-- 拟态退回对话框（替代原生 prompt） -->
    <div v-if="showFeedbackDlg" class="overlay" @click.self="showFeedbackDlg=false">
      <div class="dialog">
        <h2>💬 退回重译</h2>
        <label>退回理由（可为空）：</label>
        <textarea v-model="feedbackComment" rows="3" placeholder="说明退回原因..." data-name="feedback-comment"></textarea>
        <div class="btns">
          <button class="btn btn-cancel" @click="showFeedbackDlg=false">取消</button>
          <button class="btn btn-warn" @click="confirmFeedback" data-name="feedback-confirm">确认退回</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import "../gui-theme.css";
import { ref, computed, reactive, onMounted } from "vue";

const ready = ref(false);
const texts = ref([]);
const selectedIdx = ref(null);
const mode = ref("view");
const editText = ref("");
const showFeedbackDlg = ref(false);
const feedbackComment = ref("");

const states = reactive([]);

const approvedCount = computed(() => states.filter(s => s.status === "approved").length);
const allReviewed = computed(() => states.length > 0 && states.every(s => s.status !== "pending"));

function select(i) { selectedIdx.value = i; mode.value = "view"; }
function setState(s) {
  if (selectedIdx.value === null) return;
  if (s === "feedback") {
    feedbackComment.value = "";
    showFeedbackDlg.value = true;
  } else {
    states[selectedIdx.value].status = s;
  }
}
function confirmFeedback() {
  if (selectedIdx.value === null) return;
  states[selectedIdx.value].status = "feedback";
  states[selectedIdx.value].comment = feedbackComment.value || "未说明";
  showFeedbackDlg.value = false;
}
function submitEdit() {
  if (selectedIdx.value === null) return;
  states[selectedIdx.value].editedText = editText.value;
  states[selectedIdx.value].status = "approved";
  mode.value = "view";
}
async function approveAll() {
  const finalTexts = texts.value.map((t, i) => states[i].editedText || t);
  const feedbacks = states
    .map((s, i) => s.status === "feedback" ? { index: i, comment: s.comment } : null)
    .filter(Boolean);
  await window.go.main.App.SaveResponse(JSON.stringify({
    action: "approve",
    texts: finalTexts,
    feedbacks: feedbacks.length > 0 ? feedbacks : undefined,
  }));
  window.runtime.Quit();
}
function previewTitle(i) {
  const m = texts.value[i].match(/\*\*title\*\*:\s*(.+)/i);
  return m?.[1]?.trim() || `任务 ${i + 1}`;
}
function parseStructured(text) {
  const result = { title: "", goal: "", constraints: "", context: "" };
  const m = (re) => (text.match(re) || [, ""])[1].trim();
  result.title = m(/\*\*title\*\*:\s*(.+)/i);
  result.goal = m(/\*\*goal\*\*:\s*(.+)/i);
  result.constraints = m(/\*\*constraints\*\*:\s*([\s\S]*?)(?=\*\*user_signals|\*\*context|\*\*$)/i);
  result.context = m(/\*\*context\*\*:\s*([\s\S]*)/i);
  return result;
}
const parsed = computed(() => selectedIdx.value !== null ? parseStructured(texts.value[selectedIdx.value]) : null);
const fields = computed(() => parsed.value ? [
  { key: "title", label: "标题", value: parsed.value.title },
  { key: "goal", label: "目标", value: parsed.value.goal },
  { key: "constraints", label: "约束", value: parsed.value.constraints },
  { key: "context", label: "上下文", value: parsed.value.context },
] : []);
function statusIcon(s) { return s === "approved" ? "✅" : s === "feedback" ? "↩" : "○"; }
function statusColor(s) { return s === "approved" ? "#9ece6a" : s === "feedback" ? "#e0af68" : "#565f89"; }

onMounted(async () => {
  const data = await window.go.main.App.GetInitData();
  texts.value = data.texts || [];
  selectedIdx.value = texts.value.length > 0 ? 0 : null;
  states.length = 0;
  for (const t of texts.value) {
    states.push({ status: "pending", comment: "", editedText: "" });
  }
  ready.value = true;
  await window.go.main.App.MarkReady();
});
</script>

<style scoped>
/* ── 布局 ── */
.app { display: flex; height: 100vh; background: #1a1a2e; color: #e0e0e0; }

/* ── 侧栏 ── */
.sidebar { width: 220px; border-right: 1px solid #2a2a4a; display: flex; flex-direction: column; overflow: hidden; }
.sidebar-header { padding: 10px 14px; border-bottom: 1px solid #2a2a4a; }
.sidebar-header h1 { font-size: 14px; color: #7aa2f7; margin: 0; }
.task-count { font-size: 11px; color: #565f89; margin-top: 2px; }
.task-list { flex: 1; overflow-y: auto; }
.task-item { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #1a1a3e; display: flex; align-items: center; gap: 6px; border-left: 3px solid transparent; }
.task-item.active { background: #1a2a4a; border-left-color: #7aa2f7; }
.task-dot { font-size: 13px; flex-shrink: 0; }
.task-name { font-size: 12px; font-weight: 500; word-break: break-word; line-height: 1.3; }

/* ── 详情 ── */
.detail { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.detail-header { padding: 8px 16px; border-bottom: 1px solid #2a2a4a; display: flex; justify-content: space-between; align-items: center; }
.detail-label { font-size: 13px; color: #7aa2f7; font-weight: 600; }
.nav-hint { font-size: 11px; color: #565f89; }
.detail-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.edit-mode { gap: 8px; }
.field { display: flex; flex-direction: column; }
.field label { font-size: 11px; color: #565f89; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.field pre { background: #0d0d1a; padding: 10px 14px; border-radius: 6px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin: 0; min-height: 24px; }
.edit-label { font-size: 11px; color: #e0af68; }
.edit-area { flex: 1; background: #0d0d1a; color: #e0e0e0; border: 1px solid #7aa2f7; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 13px; resize: none; }
.empty-detail { flex: 1; display: flex; align-items: center; justify-content: center; color: #565f89; font-size: 14px; }

/* ── 操作栏 ── */
.actions { padding: 12px 16px; border-top: 1px solid #2a2a4a; display: flex; gap: 10px; }
.btn-edit { background: #7aa2f7; color: #1a1b26; }
.btn-full { width: 100%; padding: 14px; font-size: 15px; }
.approve-bar, .progress-bar { padding: 12px 16px; border-top: 1px solid #2a2a4a; text-align: center; }
.progress-bar span { font-size: 12px; color: #565f89; }

/* 拟态对话框收窄（覆盖 gui-theme 的 max-width: 500px，适配窄窗口） */
.overlay .dialog {
  width: 90%;
  max-width: 380px;
  box-sizing: border-box;
}
.dialog textarea {
  box-sizing: border-box;
}
</style>
