<template>
  <div v-if="ready" class="app">
    <!-- 左侧 worker 列表 -->
    <aside class="sidebar">
      <header class="sidebar-header">
        <div class="sidebar-title-row">
          <h1>🚀 Subagent 批次</h1>
          <span class="count-badge">{{ workers.length }}</span>
        </div>
        <label class="feedback-toggle" data-name="feedback-toggle-wrap">
          <input type="checkbox" data-name="feedback-toggle" :checked="feedback" @change="toggleFeedback" />
          <span>反馈模式（新 worker 仅 read/bash/be-*）</span>
        </label>
        <p v-if="feedbackNote" class="note">{{ feedbackNote }}</p>
      </header>

      <div class="worker-list">
        <div
          v-for="w in workers"
          :key="w.id"
          data-name="worker-item"
          :class="['worker-item', { active: selectedId === w.id }]"
          @click="select(w.id)"
        >
          <span class="status-icon">{{ statusIcon(w.status) }}</span>
          <div class="worker-info">
            <div class="worker-title">{{ w.task.slice(0, 40) }}</div>
            <div class="worker-id">{{ w.id }} · {{ statusLabel(w.status) }}</div>
          </div>
        </div>
        <div v-if="workers.length === 0" class="empty-list">暂无运行中的批次</div>
      </div>
    </aside>

    <!-- 右侧详情 -->
    <main class="detail">
      <template v-if="selected">
        <header class="detail-header">
          <div>
            <h2>{{ selected.id }} · {{ statusLabel(selected.status) }}</h2>
            <div class="detail-meta">{{ selected.model }} · 开始 {{ fmt(selected.startedAt) }}{{ selected.finishedAt ? " · 结束 " + fmt(selected.finishedAt) : "" }}</div>
          </div>
          <div class="detail-actions">
            <span v-if="selected.pid" class="pid">PID {{ selected.pid }}</span>
          </div>
        </header>

        <div class="detail-body">
          <section class="detail-section">
            <h3>任务说明</h3>
            <pre class="box" data-name="worker-detail-task">{{ selected.task }}</pre>
          </section>
          <section class="detail-section">
            <h3>状态</h3>
            <p :style="{ color: statusColor(selected.status) }" class="status-text">{{ statusLabel(selected.status) }}</p>
          </section>
          <section class="detail-section">
            <h3>最终输出</h3>
            <pre class="box" data-name="worker-detail-output">{{ selected.output || "（尚未完成）" }}</pre>
          </section>
          <section class="detail-section">
            <h3>stderr</h3>
            <pre class="box err" data-name="worker-detail-stderr">{{ selected.stderr || "（空）" }}</pre>
          </section>
          <section v-if="selected.usage" class="detail-section">
            <h3>用量</h3>
            <p class="usage">{{ usageText(selected.usage) }}</p>
          </section>
        </div>
      </template>
      <div v-else class="empty-detail">选择左侧 worker 查看详情</div>
    </main>
  </div>
</template>

<script setup>
import "../gui-theme.css";
import { ref, computed, onMounted, onUnmounted } from "vue";

const ready = ref(false);
const workers = ref([]);
const feedback = ref(false);
const feedbackNote = ref("");
const selectedId = ref(null);
const selected = computed(() => workers.value.find((w) => w.id === selectedId.value) || null);
let timer = null;

function statusIcon(s) {
  return { starting: "…", running: "▶", success: "✓", failed: "✗", aborted: "■", timeout: "⏱" }[s] || "○";
}
function statusLabel(s) {
  return { starting: "启动中", running: "执行中", success: "成功", failed: "失败", aborted: "中止", timeout: "超时" }[s] || s;
}
function statusColor(s) {
  const m = { starting: "#7aa2f7", running: "#9ece6a", success: "#565f89", failed: "#f7768e", aborted: "#e0af68", timeout: "#e0af68" };
  return m[s] || "#565f89";
}
function fmt(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-CN");
}
function usageText(u) {
  const parts = [];
  if (u.turns) parts.push(`${u.turns} 轮`);
  if (u.input) parts.push(`↑${u.input}`);
  if (u.output) parts.push(`↓${u.output}`);
  if (u.cacheRead) parts.push(`R${u.cacheRead}`);
  if (u.cacheWrite) parts.push(`W${u.cacheWrite}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  return parts.join(" ") || "—";
}
function select(id) { selectedId.value = id; }

async function poll() {
  try {
    const raw = await window.go.main.App.GetSubagentStatus();
    const data = JSON.parse(raw);
    if (Array.isArray(data.workers)) {
      workers.value = data.workers;
      if (selectedId.value && !workers.value.find((w) => w.id === selectedId.value)) selectedId.value = null;
    }
  } catch { /* 状态文件可能暂时不可读 */ }
}

async function toggleFeedback(e) {
  const next = e.target.checked;
  try {
    await window.go.main.App.SaveSubagentFeedback(next);
    feedback.value = next;
    feedbackNote.value = next ? "仅影响新启动的 worker；运行中的不受影响。" : "";
  } catch { /* 写失败保持原状 */ }
}

onMounted(async () => {
  const init = await window.go.main.App.GetInitData();
  workers.value = init.workers || [];
  feedback.value = !!init.feedback;
  feedbackNote.value = feedback.value ? "仅影响新启动的 worker；运行中的不受影响。" : "";
  ready.value = true;
  await window.go.main.App.MarkReady();
  timer = setInterval(poll, 1000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
/* ── 布局（对齐 ManagerView 配色骨架） ── */
.app { display: flex; height: 100vh; background: #1a1a2e; color: #e0e0e0; }

/* ── 侧栏 ── */
.sidebar { width: 300px; border-right: 1px solid #2a2a4a; display: flex; flex-direction: column; overflow: hidden; }
.sidebar-header { padding: 10px 14px; border-bottom: 1px solid #2a2a4a; }
.sidebar-title-row { display: flex; justify-content: space-between; align-items: center; }
.sidebar-title-row h1 { font-size: 14px; color: #7aa2f7; margin: 0; }
.count-badge { font-size: 11px; color: #565f89; }
.feedback-toggle { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11px; color: #a9b1d6; cursor: pointer; }
.feedback-toggle input { accent-color: #e0af68; cursor: pointer; }
.note { font-size: 10px; color: #565f89; margin: 6px 0 0; line-height: 1.4; }

/* ── worker 列表 ── */
.worker-list { flex: 1; overflow-y: auto; }
.worker-item { padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #1a1a3e; display: flex; align-items: center; gap: 6px; border-left: 3px solid transparent; }
.worker-item.active { background: #1a2a4a; border-left-color: #7aa2f7; }
.status-icon { font-size: 14px; flex-shrink: 0; }
.worker-info { flex: 1; min-width: 0; }
.worker-title { font-size: 12px; font-weight: 500; line-height: 1.3; word-break: break-word; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.worker-id { font-size: 10px; color: #565f89; }
.empty-list { padding: 20px; text-align: center; color: #565f89; font-size: 13px; }

/* ── 详情 ── */
.detail { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.detail-header { padding: 10px 16px; border-bottom: 1px solid #2a2a4a; display: flex; justify-content: space-between; align-items: center; }
.detail-header h2 { font-size: 15px; color: #c0caf5; margin: 0; }
.detail-meta { font-size: 11px; color: #565f89; margin-top: 2px; }
.detail-actions { display: flex; gap: 8px; align-items: center; }
.pid { font-size: 11px; color: #565f89; font-family: monospace; }

.detail-body { flex: 1; overflow-y: auto; padding: 16px; }
.detail-section { margin-bottom: 16px; }
.detail-section h3 { font-size: 11px; color: #565f89; text-transform: uppercase; margin: 0 0 4px; }
.status-text { font-size: 14px; font-weight: 600; margin: 0; }
.box { background: #0d0d1a; padding: 14px; border-radius: 6px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin: 0; max-height: 40vh; overflow-y: auto; }
.box.err { color: #f7768e; }
.usage { font-size: 12px; color: #a9b1d6; margin: 0; }

.empty-detail { flex: 1; display: flex; align-items: center; justify-content: center; color: #565f89; font-size: 14px; }
</style>
