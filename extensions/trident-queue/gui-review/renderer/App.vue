<template>
  <div v-if="!initData" class="error-empty">initData 为空</div>
  <div v-else class="app">
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

        <!-- 查看模式 -->
        <div v-if="mode==='view'" class="detail-body">
          <div v-for="f in fields" :key="f.key" class="field">
            <label>{{ f.label }}</label>
            <pre>{{ f.value || '(未识别)' }}</pre>
          </div>
        </div>

        <!-- 编辑模式 -->
        <div v-if="mode==='edit'" class="detail-body edit-mode">
          <label class="edit-label">编辑任务 {{ selectedIdx+1 }} 的描述（保持格式）</label>
          <textarea v-model="editText" class="edit-area"></textarea>
        </div>
      </template>
      <div v-else class="empty-detail">选择左侧任务查看详情</div>

      <!-- 操作栏 -->
      <footer v-if="selectedIdx !== null && mode==='view'" class="actions">
        <button @click="setState('feedback')" data-name="action-feedback" class="btn btn-warn">💬 退回重译</button>
        <button @click="mode='edit';editText=texts[selectedIdx!]" data-name="action-edit" class="btn btn-edit">✏️ 修改</button>
        <button @click="setState('approved')" data-name="action-approve" class="btn btn-allow">✅ 通过</button>
      </footer>

      <footer v-if="selectedIdx !== null && mode==='edit'" class="actions">
        <button @click="mode='view'" class="btn btn-cancel">取消</button>
        <button @click="submitEdit" data-name="action-submit-edit" class="btn btn-allow">✅ 提交修改</button>
      </footer>

      <!-- 底栏 -->
      <footer v-if="allReviewed" class="approve-bar">
        <button @click="approveAll" data-name="action-approve-all" class="btn btn-allow btn-full">✅ 全部确认（{{ approvedCount }}/{{ texts.length }}）</button>
      </footer>
      <footer v-else class="progress-bar">
        <span>审核进度：{{ approvedCount }}/{{ texts.length }}</span>
      </footer>
    </main>
  </div>
</template>

<script setup lang="ts">
import "../../../../lib/gui-theme.css";
import { ref, computed, reactive } from "vue";

const $ = (window as any).__INIT_DATA__;
const initData = !!$;
const texts: string[] = $?.texts || [];
const rsp = $?.responseFile || "";
const fs = (window as any).require("fs");

const selectedIdx = ref<number | null>(texts.length > 0 ? 0 : null);
const mode = ref<"view" | "edit">("view");
const editText = ref("");

interface TaskState { status: "pending" | "approved" | "feedback"; comment: string; editedText: string }
const states = reactive<TaskState[]>(texts.map(() => ({ status: "pending", comment: "", editedText: "" })));

const approvedCount = computed(() => states.filter(s => s.status === "approved").length);
const allReviewed = computed(() => states.every(s => s.status !== "pending"));

function select(i: number) { selectedIdx.value = i; mode.value = "view"; }
function setState(s: TaskState["status"]) {
  if (selectedIdx.value === null) return;
  if (s === "feedback") {
    const comment = prompt("退回理由（可为空）：");
    if (comment === null) return;
    states[selectedIdx.value].status = "feedback";
    states[selectedIdx.value].comment = comment || "未说明";
  } else {
    states[selectedIdx.value].status = s;
  }
}
function submitEdit() {
  if (selectedIdx.value === null) return;
  states[selectedIdx.value].editedText = editText.value;
  states[selectedIdx.value].status = "approved";
  mode.value = "view";
}
function approveAll() {
  const finalTexts = texts.map((t, i) => states[i].editedText || t);
  const feedbacks = states
    .map((s, i) => s.status === "feedback" ? { index: i, comment: s.comment } : null)
    .filter(Boolean) as Array<{ index: number; comment: string }>;
  try {
    fs.writeFileSync(rsp, JSON.stringify({ action: "approve", texts: finalTexts, feedbacks: feedbacks.length > 0 ? feedbacks : undefined }));
  } catch {}
  window.close();
}
function previewTitle(i: number): string {
  const m = texts[i].match(/\*\*title\*\*:\s*(.+)/i);
  return m?.[1]?.trim() || `任务 ${i + 1}`;
}
function parseStructured(text: string) {
  const result: Record<string, string> = { title: "", goal: "", constraints: "", context: "" };
  const m = (re: RegExp) => (text.match(re) || [, ""])[1].trim();
  result.title = m(/\*\*title\*\*:\s*(.+)/i);
  result.goal = m(/\*\*goal\*\*:\s*(.+)/i);
  result.constraints = m(/\*\*constraints\*\*:\s*([\s\S]*?)(?=\*\*user_signals|\*\*context|\*\*$)/i);
  result.context = m(/\*\*context\*\*:\s*([\s\S]*)/i);
  return result;
}
const parsed = computed(() => selectedIdx.value !== null ? parseStructured(texts[selectedIdx.value]) : null);
const fields = computed(() => parsed.value ? [
  { key: "title", label: "标题", value: parsed.value.title },
  { key: "goal", label: "目标", value: parsed.value.goal },
  { key: "constraints", label: "约束", value: parsed.value.constraints },
  { key: "context", label: "上下文", value: parsed.value.context },
] : []);
function statusIcon(s: string) { return s === "approved" ? "✅" : s === "feedback" ? "↩" : "○"; }
function statusColor(s: string) { return s === "approved" ? "#9ece6a" : s === "feedback" ? "#e0af68" : "#565f89"; }
</script>

<style scoped>
/* ── 布局 ── */
.app { display: flex; height: 100vh; background: var(--bg, #1a1a2e); color: var(--fg, #e0e0e0); }
.error-empty { color: red; padding: 20px; }

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
</style>
