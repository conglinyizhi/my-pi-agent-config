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
          <section class="detail-section task-section">
            <h3>任务说明</h3>
            <pre class="box task-box" data-name="worker-detail-task">{{ selected.task }}</pre>
          </section>

          <section class="summary-strip">
            <span class="status-dot" :style="{ background: statusColor(selected.status) }"></span>
            <span class="status-text" :style="{ color: statusColor(selected.status) }">{{ statusLabel(selected.status) }}</span>
            <span v-if="selected.usage" class="usage">{{ usageText(selected.usage) }}</span>
          </section>

          <!-- 实时执行时间线：固定行高虚拟滚动 -->
          <section class="timeline-section">
            <div class="timeline-title-row">
              <h3>执行时间线</h3>
              <span class="timeline-count">{{ events.length }} 条</span>
              <span class="timeline-follow" :class="{ off: !atBottom }">{{ atBottom ? "跟随最新" : "已冻结" }}</span>
            </div>
            <div class="timeline-wrap">
              <div ref="viewport" class="timeline-viewport" data-name="timeline-viewport" @scroll="onScroll">
                <div class="tl-spacer" :style="{ height: topPad + 'px' }"></div>
                <div
                  v-for="ev in visibleEvents"
                  :key="ev.id"
                  data-name="timeline-row"
                  class="timeline-row"
                  :class="['tl-' + ev.type, { expanded: isExpanded(ev.id) }]"
                  :style="{ borderLeftColor: eventColor(ev) }"
                  @click="toggleExpand(ev)"
                >
                  <span class="tl-icon" :style="{ color: eventColor(ev) }">{{ eventIcon(ev) }}</span>
                  <span class="tl-title">{{ eventTitle(ev) }}</span>
                  <span class="tl-ts">{{ shortTs(ev) }}</span>
                </div>
                <div class="tl-spacer" :style="{ height: bottomPad + 'px' }"></div>
                <div v-if="events.length === 0" class="tl-empty">暂无轨迹事件</div>
              </div>

              <!-- 受控详情区：展开内容不参与虚拟行高计算 -->
              <div v-if="expandedEvents.length" class="timeline-detail" data-name="timeline-detail">
                <div v-for="ev in expandedEvents" :key="ev.id" class="tl-detail-card">
                  <div class="tl-detail-head">
                    <span class="tl-detail-title">{{ detailTitle(ev) }}</span>
                    <span class="tl-detail-ts">{{ fmt(ev.ts) }}</span>
                    <button class="tl-detail-close" @click.stop="toggleExpand(ev)">收起</button>
                  </div>
                  <div class="tl-detail-body">
                    <template v-if="ev.type === 'tool'">
                      <div v-if="ev.args !== undefined" class="tl-field">
                        <label>参数</label>
                        <pre>{{ ev.args }}</pre>
                      </div>
                      <div v-if="ev.preview !== undefined" class="tl-field">
                        <label>增量输出</label>
                        <pre>{{ ev.preview }}</pre>
                      </div>
                      <div v-if="ev.result !== undefined" class="tl-field">
                        <label>最终结果</label>
                        <pre :class="{ err: ev.ok === false }">{{ ev.result }}</pre>
                      </div>
                      <div v-if="ev.ok !== undefined" class="tl-field inline">
                        <label>状态</label>
                        <span :class="ev.ok ? 'ok' : 'err'">{{ ev.ok ? "成功" : "失败" }}</span>
                      </div>
                    </template>
                    <template v-else-if="ev.type === 'assistant'">
                      <div class="tl-field">
                        <label>回复{{ ev.final ? "（已结束）" : "（流式中）" }}</label>
                        <pre>{{ ev.text || "（空）" }}</pre>
                      </div>
                    </template>
                    <template v-else>
                      <div class="tl-field">
                        <label>生命周期</label>
                        <pre>{{ ev.state }} {{ ev.message || "" }}</pre>
                      </div>
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="terminal-section">
            <h3>最终输出</h3>
            <pre class="box compact" data-name="worker-detail-output">{{ selected.output || "（尚未完成）" }}</pre>
          </section>
          <section class="terminal-section">
            <h3>stderr</h3>
            <pre class="box compact err" data-name="worker-detail-stderr">{{ selected.stderr || "（空）" }}</pre>
          </section>
        </div>
      </template>
      <div v-else class="empty-detail">选择左侧 worker 查看详情</div>
    </main>
  </div>
</template>

<script setup>
import "../gui-theme.css";
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";

// 虚拟滚动常量：固定行高是行距数学的唯一基准，展开内容不改变它
const ROW_H = 40; // 每行固定高度（px）
const OVERSCAN = 5; // 视口外预渲染行数，减少滚动闪白

const ready = ref(false);
const workers = ref([]);
const feedback = ref(false);
const feedbackNote = ref("");
const selectedId = ref(null);
const selected = computed(() => workers.value.find((w) => w.id === selectedId.value) || null);
const events = computed(() => selected.value?.timeline || []);

// ── 虚拟滚动状态 ──
const viewport = ref(null);
const scrollTop = ref(0);
const viewportH = ref(0);
let atBottom = true; // 轮询刷新前用户是否停留在底部（决定是否自动跟随）
const expandedKeys = ref(new Set()); // "workerId::eventId" 集合：跨轮询保留展开状态

let timer = null;
let ro = null;

function expandedKey(id) {
  return selectedId.value + "::" + id;
}
function isExpanded(id) {
  return expandedKeys.value.has(expandedKey(id));
}

function measure() {
  const el = viewport.value;
  if (!el) return;
  scrollTop.value = el.scrollTop;
  viewportH.value = el.clientHeight;
}
function isAtBottom() {
  const el = viewport.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}
function onScroll() {
  measure();
  atBottom = isAtBottom();
}
function scrollToBottom() {
  const el = viewport.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  measure();
  atBottom = true;
}

const startIndex = computed(() => {
  const n = events.value.length;
  if (!n) return 0;
  const raw = Math.floor(scrollTop.value / ROW_H) - OVERSCAN;
  return Math.max(0, Math.min(raw, n - 1));
});
const endIndex = computed(() => {
  const n = events.value.length;
  if (!n) return 0;
  const visible = Math.ceil(viewportH.value / ROW_H) + OVERSCAN * 2;
  return Math.min(n, startIndex.value + visible);
});
const visibleEvents = computed(() => events.value.slice(startIndex.value, endIndex.value));
const topPad = computed(() => startIndex.value * ROW_H);
const bottomPad = computed(() => (events.value.length - endIndex.value) * ROW_H);
const expandedEvents = computed(() => events.value.filter((ev) => isExpanded(ev.id)));

// ── 展示辅助 ──
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
function shortTs(ev) {
  if (!ev.ts) return "-";
  const d = new Date(ev.ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString("zh-CN", { hour12: false });
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

function lifecycleLabel(s) {
  return { starting: "启动", running: "执行中", success: "成功", failed: "失败", aborted: "中止", timeout: "超时", truncated: "历史截断" }[s] || s;
}
function eventIcon(ev) {
  if (ev.type === "assistant") return ev.final ? "💬" : "…";
  if (ev.type === "tool") {
    if (ev.ok === false) return "✗";
    if (ev.ok === true) return "✓";
    return "▶";
  }
  const m = { starting: "●", running: "●", success: "✓", failed: "✗", aborted: "■", timeout: "⏱", truncated: "…" };
  return m[ev.state] || "●";
}
function eventColor(ev) {
  if (ev.type === "assistant") return "#7aa2f7";
  if (ev.type === "tool") return ev.ok === false ? "#f7768e" : ev.ok === true ? "#9ece6a" : "#e0af68";
  const m = { starting: "#7aa2f7", running: "#9ece6a", success: "#9ece6a", failed: "#f7768e", aborted: "#e0af68", timeout: "#e0af68", truncated: "#565f89" };
  return m[ev.state] || "#565f89";
}
function eventTitle(ev) {
  if (ev.type === "tool") {
    const st = ev.ok === false ? "失败" : ev.ok === true ? "完成" : "执行中";
    return `${ev.tool} · ${st}`;
  }
  if (ev.type === "assistant") {
    const t = (ev.text || "").replace(/\s+/g, " ").trim();
    return t ? t : ev.final ? "（空回复）" : "（回复中…）";
  }
  return lifecycleLabel(ev.state) + (ev.message ? " · " + ev.message : "");
}
function detailTitle(ev) {
  if (ev.type === "tool") return `工具 ${ev.tool}`;
  if (ev.type === "assistant") return "助手回复";
  return `生命周期 · ${lifecycleLabel(ev.state)}`;
}

// ── 交互 ──
function select(id) {
  selectedId.value = id;
  // 切换 worker：回到底部跟随最新；展开集合按 workerId::eventId 隔离保留
  nextTick(() => {
    measure();
    scrollToBottom();
  });
}
function toggleExpand(ev) {
  const k = expandedKey(ev.id);
  const s = new Set(expandedKeys.value);
  if (s.has(k)) s.delete(k);
  else s.add(k);
  expandedKeys.value = s;
  nextTick(() => measure()); // 详情区出现/收起会改变视口高度
}

async function poll() {
  try {
    const raw = await window.go.main.App.GetSubagentStatus();
    const data = JSON.parse(raw);
    if (Array.isArray(data.workers)) {
      workers.value = data.workers;
      if (selectedId.value && !workers.value.find((w) => w.id === selectedId.value)) selectedId.value = null;
      await nextTick();
      // 新事件到达：刷新前在底部则跟随到底；用户上滚过则冻结，不强制跳转
      if (atBottom) scrollToBottom();
      else measure();
    }
  } catch {
    // 轮询/解析失败：保留最后有效数据与滚动位置
  }
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
  await nextTick();
  measure();
  scrollToBottom();
  if (typeof ResizeObserver !== "undefined" && viewport.value) {
    ro = new ResizeObserver(() => measure());
    ro.observe(viewport.value);
  }
  timer = setInterval(poll, 1000);
});
onUnmounted(() => {
  clearInterval(timer);
  if (ro) ro.disconnect();
});
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

.detail-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
.detail-section { margin-bottom: 12px; }
.detail-section h3 { font-size: 11px; color: #565f89; text-transform: uppercase; margin: 0 0 4px; }
.task-box { max-height: 90px; overflow-y: auto; margin: 0; }
.summary-strip { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 12px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.status-text { font-weight: 600; margin: 0; }
.usage { color: #a9b1d6; }

/* ── 时间线（固定行高虚拟滚动） ── */
.timeline-section { height: 42vh; min-height: 240px; display: flex; flex-direction: column; margin-bottom: 12px; }
.timeline-title-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.timeline-title-row h3 { font-size: 11px; color: #565f89; text-transform: uppercase; margin: 0; }
.timeline-count { font-size: 10px; color: #565f89; }
.timeline-follow { font-size: 10px; color: #565f89; margin-left: auto; }
.timeline-follow.off { color: #e0af68; }
.timeline-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; border: 1px solid #2a2a4a; border-radius: 6px; background: #0d0d1a; }
.timeline-viewport { flex: 1; overflow-y: auto; min-height: 0; }
.timeline-row { height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 10px; cursor: pointer; border-left: 3px solid transparent; border-bottom: 1px solid #16162a; font-size: 12px; user-select: none; }
.timeline-row:hover { background: #16213e; }
.timeline-row.expanded { background: #1a2a4a; }
.tl-icon { flex-shrink: 0; width: 16px; text-align: center; font-size: 12px; }
.tl-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #c0caf5; }
.tl-ts { flex-shrink: 0; font-size: 10px; color: #565f89; font-family: monospace; }
.tl-spacer { flex-shrink: 0; }
.tl-empty { padding: 20px; text-align: center; color: #565f89; font-size: 12px; }

/* 受控详情区：展开内容在此区滚动，不参与虚拟行高计算 */
.timeline-detail { flex: 0 1 auto; max-height: 45%; overflow-y: auto; border-top: 1px solid #2a2a4a; }
.tl-detail-card { border-bottom: 1px solid #16162a; padding: 8px 10px; }
.tl-detail-head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.tl-detail-title { color: #c0caf5; font-weight: 600; }
.tl-detail-ts { font-size: 10px; color: #565f89; font-family: monospace; }
.tl-detail-close { margin-left: auto; background: none; border: 1px solid #2a2a4a; color: #a9b1d6; font-size: 10px; border-radius: 3px; padding: 1px 8px; cursor: pointer; }
.tl-detail-close:hover { background: #16213e; }
.tl-detail-body { margin-top: 6px; }
.tl-field { margin-bottom: 6px; }
.tl-field label { display: block; font-size: 10px; color: #565f89; text-transform: uppercase; margin-bottom: 2px; }
.tl-field pre { margin: 0; background: #0d0d1a; border: 1px solid #16162a; border-radius: 4px; padding: 6px 8px; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 30vh; overflow-y: auto; color: #c0caf5; }
.tl-field pre.err { color: #f7768e; }
.tl-field .ok { color: #9ece6a; font-size: 12px; }
.tl-field .err { color: #f7768e; font-size: 12px; }

/* ── 终端结果（紧凑，保留最终输出/stderr） ── */
.terminal-section h3 { font-size: 11px; color: #565f89; text-transform: uppercase; margin: 0 0 4px; }
.box { background: #0d0d1a; padding: 14px; border-radius: 6px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin: 0; }
.box.compact { max-height: 110px; overflow-y: auto; padding: 8px 10px; font-size: 12px; margin-bottom: 12px; }
.box.err { color: #f7768e; }

.empty-detail { flex: 1; display: flex; align-items: center; justify-content: center; color: #565f89; font-size: 14px; }
</style>
