<template>
  <div v-if="ready" class="app">
    <!-- 左侧列表 -->
    <aside class="sidebar">
      <header class="sidebar-header">
        <div class="sidebar-title-row">
          <h1>⚓ 舰队事项</h1>
          <span class="count-badge">{{ tasks.length }}</span>
        </div>
        <div v-if="checkedCount>0" class="selected-hint">已选 {{ checkedCount }} 个</div>
      </header>

      <div v-if="checkedCount>0" class="batch-bar">
        <button v-if="canStartChecked" @click="batch('start')" data-name="batch-start" class="btn-batch btn-start">▶ 启动</button>
        <button v-if="canKillChecked" @click="batch('kill')" data-name="batch-kill" class="btn-batch btn-kill">⏹ 终止</button>
      </div>

      <div class="task-list">
        <div v-for="t in tasks" :key="t.id" @click="select(t.id)" :class="['task-item', { active: selectedId===t.id }]">
          <input type="checkbox" :checked="checked.has(t.id)" @click.stop="toggleCheck(t.id)" class="task-check">
          <span class="task-status-icon">{{ statusIcon(t.status) }}</span>
          <div class="task-info">
            <div class="task-title">{{ t.title }}</div>
            <div class="task-id">{{ t.id }}</div>
          </div>
        </div>
        <div v-if="tasks.length===0" class="empty-list">暂无事项</div>
      </div>
    </aside>

    <!-- 右侧详情 -->
    <main class="detail">
      <template v-if="selected">
        <header class="detail-header">
          <div>
            <h2>{{ selected.title }}</h2>
            <div class="detail-meta">{{ selected.id }} · {{ new Date(selected.created_at).toLocaleString("zh-CN") }}</div>
          </div>
          <div class="detail-actions">
            <span :style="{color: statusColor(selected.status)}" class="status-badge">{{ statusLabel(selected.status) }}</span>
            <button v-if="selected.status==='executing'" @click="killOne" data-name="action-kill" class="btn-detail btn-kill">⏹ 终止</button>
            <button v-if="selected.status==='pending'||selected.status==='blocked'" @click="startOne" data-name="action-start" class="btn-detail btn-start">▶ 启动</button>
          </div>
        </header>

        <div class="detail-body">
          <section class="detail-section">
            <h3>状态</h3>
            <p :style="{color: statusColor(selected.status)}" class="status-text">{{ statusLabel(selected.status) }}</p>
          </section>
          <section class="detail-section">
            <div class="section-header">
              <h3>详细内容</h3>
              <span v-if="selected.status==='executing'" class="live-hint">后台运行中，内容非实时</span>
            </div>
            <pre class="context-box">{{ selected.context }}</pre>
          </section>
        </div>
      </template>
      <div v-else class="empty-detail">选择左侧任务查看详情</div>
    </main>
  </div>
</template>

<script setup>
import "../gui-theme.css";
import { ref, computed, reactive, onMounted } from "vue";

const ready = ref(false);
const tasks = ref([]);
const selectedId = ref(null);
const checked = reactive(new Set());

const selected = computed(() => tasks.value.find((t) => t.id === selectedId.value) || null);
const checkedCount = computed(() => checked.size);

const canStartChecked = computed(() => {
  if (checked.size === 0) return false;
  return [...checked].some((id) => {
    const t = tasks.value.find((t) => t.id === id);
    return t && (t.status === "pending" || t.status === "blocked");
  });
});

const canKillChecked = computed(() => {
  if (checked.size === 0) return false;
  return [...checked].every((id) => {
    const t = tasks.value.find((t) => t.id === id);
    return t && t.status === "executing";
  });
});

function select(id) { selectedId.value = id; }
function toggleCheck(id) { checked.has(id) ? checked.delete(id) : checked.add(id); }

function statusIcon(s) {
  const m = { pending: "○", executing: "▶", done: "✓", blocked: "⏸" };
  return m[s] || "○";
}
function statusColor(s) {
  const m = { pending: "#7aa2f7", executing: "#9ece6a", done: "#565f89", blocked: "#e0af68" };
  return m[s] || "#565f89";
}
function statusLabel(s) {
  const m = { pending: "待执行", executing: "执行中", done: "已完成", blocked: "已阻塞" };
  return m[s] || s;
}

async function respond(payload) {
  await window.go.main.App.SaveResponse(JSON.stringify(payload));
  window.runtime.Quit();
}
function batch(op) {
  const ops = [...checked].map((taskId) => ({ taskId, op }));
  respond({ action: "batch", ops });
}
function killOne() {
  if (!selected.value) return;
  respond({ action: "batch", ops: [{ taskId: selected.value.id, op: "kill" }] });
}
function startOne() {
  if (!selected.value) return;
  respond({ action: "batch", ops: [{ taskId: selected.value.id, op: "start" }] });
}

onMounted(async () => {
  const data = await window.go.main.App.GetInitData();
  tasks.value = data.tasks || [];
  ready.value = true;
  await window.go.main.App.MarkReady();
});
</script>

<style scoped>
/* ── 布局 ── */
.app { display: flex; height: 100vh; background: #1a1a2e; color: #e0e0e0; }

/* ── 侧栏 ── */
.sidebar { width: 300px; border-right: 1px solid #2a2a4a; display: flex; flex-direction: column; overflow: hidden; }
.sidebar-header { padding: 10px 14px; border-bottom: 1px solid #2a2a4a; }
.sidebar-title-row { display: flex; justify-content: space-between; align-items: center; }
.sidebar-title-row h1 { font-size: 14px; color: #7aa2f7; margin: 0; }
.count-badge { font-size: 11px; color: #565f89; }
.selected-hint { font-size: 11px; color: #e0af68; margin-top: 4px; }

/* ── 批量操作 ── */
.batch-bar { padding: 6px 10px; border-bottom: 1px solid #2a2a4a; display: flex; gap: 6px; }
.btn-batch { flex: 1; padding: 5px; border: none; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; }
.btn-start { background: #9ece6a; color: #1a1b26; }
.btn-kill { background: #f7768e; color: #1a1b26; }

/* ── 任务列表 ── */
.task-list { flex: 1; overflow-y: auto; }
.task-item { padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #1a1a3e; display: flex; align-items: center; gap: 6px; border-left: 3px solid transparent; }
.task-item.active { background: #1a2a4a; border-left-color: #7aa2f7; }
.task-check { accent-color: #7aa2f7; cursor: pointer; flex-shrink: 0; }
.task-status-icon { font-size: 14px; flex-shrink: 0; }
.task-info { flex: 1; min-width: 0; }
.task-title { font-size: 12px; font-weight: 500; line-height: 1.3; word-break: break-word; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-id { font-size: 10px; color: #565f89; }
.empty-list { padding: 20px; text-align: center; color: #565f89; font-size: 13px; }

/* ── 详情 ── */
.detail { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.detail-header { padding: 10px 16px; border-bottom: 1px solid #2a2a4a; display: flex; justify-content: space-between; align-items: center; }
.detail-header h2 { font-size: 15px; color: #c0caf5; margin: 0; }
.detail-meta { font-size: 11px; color: #565f89; margin-top: 2px; }
.detail-actions { display: flex; gap: 8px; align-items: center; }
.status-badge { font-size: 13px; font-weight: 600; }
.btn-detail { padding: 4px 12px; border: none; border-radius: 5px; font-size: 12px; font-weight: 600; cursor: pointer; }
.btn-detail.btn-start { background: #9ece6a; color: #1a1b26; }
.btn-detail.btn-kill { background: #f7768e; color: #1a1b26; }

.detail-body { flex: 1; overflow-y: auto; padding: 16px; }
.detail-section { margin-bottom: 16px; }
.detail-section h3 { font-size: 11px; color: #565f89; text-transform: uppercase; margin: 0 0 4px; }
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.live-hint { font-size: 10px; color: #565f89; }
.status-text { font-size: 14px; font-weight: 600; margin: 0; }
.context-box { background: #0d0d1a; padding: 14px; border-radius: 6px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin: 0; max-height: calc(100vh - 260px); overflow-y: auto; }

.empty-detail { flex: 1; display: flex; align-items: center; justify-content: center; color: #565f89; font-size: 14px; }
</style>
