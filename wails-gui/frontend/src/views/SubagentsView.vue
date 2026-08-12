<template>
  <div v-if="ready" class="app">
    <!-- 层级 1：Agent 列表（全窗口） -->
    <section v-if="viewLevel === 'agents'" data-name="agent-list" class="agents-view">
      <header class="agents-header">
        <div class="agents-title-row">
          <h1>Subagent 批次</h1>
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
          data-name="agent-item"
          :class="['agent-item', { active: selectedId === w.id }]"
          @click="select(w.id)"
        >
          <span class="status-icon">{{ statusIcon(w.status) }}</span>
          <div class="worker-info">
            <div class="worker-title">{{ w.task.slice(0, 40) }}</div>
            <div class="worker-id">{{ w.id }} · {{ statusLabel(w.status) }}</div>
          </div>
          <span class="row-chevron">›</span>
        </div>
        <div v-if="workers.length === 0" class="empty-list">暂无运行中的批次</div>
      </div>
    </section>

    <!-- 层级 2：选中 worker 的全宽时间线 -->
    <section v-else-if="viewLevel === 'timeline'" data-name="event-list" class="timeline-view">
      <header class="top-bar">
        <button class="back-btn" data-name="timeline-back" title="返回批次列表" @click="backToAgents">‹</button>
        <div class="top-info">
          <h2>{{ selected?.id || "-" }} · {{ statusLabel(selected?.status) }}</h2>
          <div class="top-meta">
            <span class="crumb">Agent 列表 / {{ selected?.id || "-" }}</span>
            <span>{{ selected?.model || "-" }}{{ selected?.pid ? " · PID " + selected.pid : "" }}</span>
            <span>{{ events.length }} 条事件{{ selected?.usage ? " · " + usageText(selected.usage) : "" }}</span>
          </div>
        </div>
        <span class="follow-hint" :class="{ off: !atBottom }">{{ atBottom ? "跟随最新" : "已冻结" }}</span>
      </header>

      <div ref="viewport" class="timeline-viewport" data-name="timeline-viewport" @scroll="onScroll">
        <div class="tl-spacer" :style="{ height: topPad + 'px' }"></div>
        <div
          v-for="ev in visibleEvents"
          :key="ev.id"
          data-name="timeline-row"
          class="timeline-row"
          :class="['tl-' + ev.type]"
          :style="{ borderLeftColor: eventColor(ev) }"
          @click="openEvent(ev.id)"
        >
          <span class="tl-icon" :style="{ color: eventColor(ev) }">{{ eventIcon(ev) }}</span>
          <span class="tl-title">{{ eventTitle(ev) }}</span>
          <span class="tl-ts">{{ shortTs(ev) }}</span>
        </div>
        <div class="tl-spacer" :style="{ height: bottomPad + 'px' }"></div>
        <div v-if="events.length === 0" class="tl-empty">暂无轨迹事件</div>
      </div>
    </section>

    <!-- 层级 3：单条事件详情（底部固定 previous/next 栏） -->
    <section v-else data-name="event-detail" class="event-view">
      <header class="top-bar">
        <button class="back-btn" data-name="event-back" title="返回时间线" @click="backToTimeline">‹</button>
        <div class="top-info">
          <h2>{{ currentEvent ? detailTitle(currentEvent) : "-" }}</h2>
          <div class="top-meta">
            <span class="crumb">Agent 列表 / {{ selected?.id || "-" }} / {{ currentEvent ? detailTitle(currentEvent) : "-" }}</span>
            <span>{{ currentEvent ? fmt(currentEvent.ts) : "-" }}</span>
          </div>
        </div>
      </header>

      <div ref="detailViewport" class="detail-body">
        <template v-if="currentEvent">
          <template v-if="currentEvent.type === 'tool'">
            <div v-if="currentEvent.args !== undefined" class="detail-field">
              <label>参数</label>
              <pre>{{ currentEvent.args }}</pre>
            </div>
            <div v-if="currentEvent.preview !== undefined" class="detail-field">
              <label>增量输出</label>
              <pre>{{ currentEvent.preview }}</pre>
            </div>
            <div v-if="currentEvent.result !== undefined" class="detail-field">
              <label>最终结果</label>
              <pre :class="{ err: currentEvent.ok === false }">{{ currentEvent.result }}</pre>
            </div>
            <div v-if="currentEvent.ok !== undefined" class="detail-field inline">
              <label>状态</label>
              <span :class="currentEvent.ok ? 'ok' : 'err'">{{ currentEvent.ok ? "成功" : "失败" }}</span>
            </div>
          </template>

          <template v-else-if="currentEvent.type === 'assistant'">
            <div class="detail-field">
              <label>助手回复{{ currentEvent.final ? "（已结束）" : "（流式中）" }}</label>
              <pre class="assistant-text">{{ currentEvent.text || "（空）" }}</pre>
            </div>
          </template>

          <template v-else-if="currentEvent.type === 'terminal'">
            <div class="detail-field">
              <label>{{ currentEvent.stream === "stderr" ? "stderr 原文" : "终端输出原文" }}</label>
              <pre :class="{ err: currentEvent.stream === 'stderr' }">{{ currentEvent.text || "（空）" }}</pre>
            </div>
          </template>

          <template v-else-if="currentEvent.type === 'supplement'">
            <div class="detail-field">
              <label>Supplement sent to worker</label>
              <pre class="supplement-text">{{ currentEvent.text || "（空）" }}</pre>
            </div>
          </template>

          <template v-else>
            <div class="detail-field">
              <label>生命周期</label>
              <pre>{{ currentEvent.state }} {{ currentEvent.message || "" }}</pre>
            </div>
          </template>
        </template>
        <div v-else class="empty-detail">该事件已不存在</div>
      </div>

      <!-- 补充指令 composer：active（蓝）/ terminal（灰）两种模式，队列行在下方 -->
      <section v-if="selected && (selected.inboxId || selectedWorkerTerminal)" class="supplement-composer" data-name="supplement-composer">
        <template v-if="selectedWorkerActive">
          <div class="comp-row">
            <textarea
              v-model="supplementDrafts[selected.id]"
              class="comp-textarea"
              rows="2"
              data-name="supplement-draft"
              placeholder="补充指令——将进入 FIFO 队列，由 worker 领取执行…"
            ></textarea>
          </div>
          <div class="comp-actions">
            <button
              class="comp-btn comp-btn-blue"
              data-name="queue-supplement"
              :disabled="!draftNonBlank"
              @click="queueSupplement"
            >Queue supplement</button>
            <span v-if="queueFeedback" class="comp-feedback" :class="'comp-feedback-' + queueFeedbackKind">{{ queueFeedback }}</span>
          </div>
        </template>

        <template v-else>
          <div class="comp-row">
            <textarea
              v-model="supplementDrafts[selected.id]"
              class="comp-textarea"
              rows="2"
              data-name="supplement-draft"
              placeholder="草稿——worker 生命周期已结束，复制给主 agent 使用…"
            ></textarea>
          </div>
          <div class="comp-actions">
            <button
              class="comp-btn comp-btn-gray"
              data-name="copy-supplement"
              :disabled="!copyTextNonBlank"
              @click="copyForMainAgent"
            >Copy for main agent</button>
            <span v-if="copyFeedback" class="comp-feedback" :class="'comp-feedback-' + copyFeedbackKind">{{ copyFeedback }}</span>
          </div>
          <p class="comp-terminal-note">Worker lifecycle has ended. It cannot receive further supplements. Copy the draft to the main agent instead.</p>
        </template>

        <div v-if="supplements.length" class="comp-queue" data-name="supplement-queue">
          <div
            v-for="(entry, i) in supplements"
            :key="entry.id"
            class="comp-entry"
            :class="entry.state === 'pending' ? 'comp-entry-pending' : 'comp-entry-handoff'"
          >
            <span class="comp-entry-idx">{{ i + 1 }}</span>
            <span class="comp-entry-text">{{ entry.text }}</span>
            <span v-if="entry.state === 'handoff'" class="comp-entry-state">Handed to Pi steering queue</span>
            <button v-else class="comp-btn comp-btn-amber comp-btn-mini" data-name="withdraw-supplement" @click="withdrawEntry(entry)">Withdraw</button>
          </div>
        </div>
        <div v-if="pendingSupplements.length >= 2" class="comp-actions comp-merge-row">
          <button class="comp-btn comp-btn-amber-outline" data-name="merge-supplements" @click="mergePending">Merge pending</button>
          <span class="comp-merge-count">{{ pendingSupplements.length }} 条待合并</span>
        </div>
      </section>

      <footer class="detail-bar">
        <button class="nav-btn" data-name="previous-event" :disabled="!prevId" title="上一条" @click="goPrevious">‹ 上一条</button>
        <span data-name="event-position" class="event-position">{{ eventPosition }}</span>
        <button class="nav-btn" data-name="next-event" :disabled="!nextId" title="下一条" @click="goNext">下一条 ›</button>
      </footer>
    </section>
  </div>
</template>

<script setup>
import "../gui-theme.css";
import { ref, computed, reactive, watch, onMounted, onUnmounted, nextTick } from "vue";
import { readerEvents, eventIndex, adjacentEventId } from "../subagent-reader.js";
import { reconcileNavigation, shouldFollowTimeline } from "../subagent-navigation.js";
import { ClipboardSetText } from "../../wailsjs/runtime/runtime.js";

// 虚拟滚动常量：固定行高是行距数学的唯一基准
const ROW_H = 40; // 每行固定高度（px）
const OVERSCAN = 5; // 视口外预渲染行数，减少滚动闪白

const ready = ref(false);
const workers = ref([]);
const feedback = ref(false);
const feedbackNote = ref("");

// ── 三级页面栈状态 ──
const viewLevel = ref("agents"); // "agents" | "timeline" | "event"
const selectedId = ref(null);
const selectedEventId = ref(null);
const scrollMap = {}; // workerId -> timeline scrollTop（跨层级保留）

const selected = computed(() => workers.value.find((w) => w.id === selectedId.value) || null);
const events = computed(() => (selected.value ? readerEvents(selected.value) : []));
const currentEvent = computed(() => events.value.find((e) => e.id === selectedEventId.value) || null);

// ── 虚拟滚动状态（层级 2） ──
const viewport = ref(null);
const scrollTop = ref(0);
const viewportH = ref(0);
let atBottom = true; // 轮询刷新前用户是否停留在底部（决定是否自动跟随）

// ── 详情视口（层级 3，previous/next 时重置滚动） ──
const detailViewport = ref(null);

// ── 补充指令 composer ──
// 草稿按 worker id 本地保存：跨事件导航 / 跨 worker 切换不丢字。
const supplementDrafts = reactive({});
const queueFeedback = ref("");
const queueFeedbackKind = ref("ok");
const copyFeedback = ref("");
const copyFeedbackKind = ref("ok");
let feedbackTimer = null;

function isActiveStatus(s) {
  return s === "starting" || s === "running";
}

const selectedWorkerTerminal = computed(() => {
  const w = selected.value;
  return !!w && !isActiveStatus(w.status);
});

// worker active：生命周期 active 且带有效 inboxId 才可 enqueue。
const selectedWorkerActive = computed(() => {
  const w = selected.value;
  return !!w && !!w.inboxId && isActiveStatus(w.status);
});

// 队列条目来自轮询富化后的 selected.supplements（缺失/损坏已由 Go 降级为 []）。
const supplements = computed(() => {
  const w = selected.value;
  return w && Array.isArray(w.supplements) ? w.supplements : [];
});
const pendingSupplements = computed(() => supplements.value.filter((e) => e && e.state === "pending"));

const draftNonBlank = computed(() => {
  const w = selected.value;
  return !!w && (supplementDrafts[w.id] || "").trim() !== "";
});
const copyTextNonBlank = computed(() => {
  const w = selected.value;
  if (!w) return false;
  if ((supplementDrafts[w.id] || "").trim() !== "") return true;
  return pendingSupplements.value.some((e) => e.text && e.text.trim() !== "");
});

// 切换 worker 时确保草稿槽存在（v-model 需要响应式键已初始化）。
watch(selectedId, (id) => {
  if (id != null && !(id in supplementDrafts)) supplementDrafts[id] = "";
});

function flashQueue(kind, msg) {
  queueFeedbackKind.value = kind;
  queueFeedback.value = msg;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    queueFeedback.value = "";
    copyFeedback.value = "";
  }, 4000);
}
function flashCopy(kind, msg) {
  copyFeedbackKind.value = kind;
  copyFeedback.value = msg;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    copyFeedback.value = "";
    queueFeedback.value = "";
  }, 4000);
}

// active：入队。结果由下一次轮询拉取；草稿仅在成功 await 后本地清空。
async function queueSupplement() {
  const w = selected.value;
  if (!w || !w.inboxId) return;
  const text = (supplementDrafts[w.id] || "").trim();
  if (!text) {
    flashQueue("err", "草稿为空，未入队");
    return;
  }
  try {
    await window.go.main.App.QueueSubagentSupplement(w.inboxId, text);
    supplementDrafts[w.id] = "";
    flashQueue("ok", "已入队，等待 worker 领取");
  } catch (e) {
    flashQueue("err", String((e && e.message) || e));
  }
}

// 撤回单条 pending；handoff 行无此按钮。terminal 同样允许。
async function withdrawEntry(entry) {
  const w = selected.value;
  if (!w || !w.inboxId) return;
  try {
    await window.go.main.App.WithdrawSubagentSupplement(w.inboxId, entry.id);
    flashQueue("ok", "已撤回");
  } catch (e) {
    flashQueue("err", String((e && e.message) || e));
  }
}

// 合并全部 pending（>=2 才显示按钮）。
async function mergePending() {
  const w = selected.value;
  if (!w || !w.inboxId || pendingSupplements.value.length < 2) return;
  try {
    await window.go.main.App.MergeSubagentSupplements(w.inboxId);
    flashQueue("ok", "已合并全部 pending");
  } catch (e) {
    flashQueue("err", String((e && e.message) || e));
  }
}

// terminal：草稿 + 全部 pending（FIFO，排除 handoff）拼成剪贴板文本。
function buildCopyText() {
  const w = selected.value;
  if (!w) return "";
  const parts = [];
  const draft = (supplementDrafts[w.id] || "").trim();
  if (draft) parts.push(draft);
  pendingSupplements.value.forEach((e, i) => {
    if (i > 0) parts.push(`--- Supplement ${i + 1} ---`);
    parts.push(e.text);
  });
  return parts.join("\n\n");
}
async function copyForMainAgent() {
  const text = buildCopyText();
  if (!text.trim()) {
    flashCopy("err", "草稿与队列均为空");
    return;
  }
  try {
    const ok = await ClipboardSetText(text);
    flashCopy(ok === false ? "err" : "ok", ok === false ? "复制失败" : "已复制到剪贴板");
  } catch (e) {
    flashCopy("err", "复制失败：" + String((e && e.message) || e));
  }
}

let timer = null;
let ro = null;

// ── timeline viewport 的 ResizeObserver 生命周期 ──
// viewport ref 只在 timeline 层挂载；初始 agents 层为 null，onMounted 时无法绑定。
// 每次 timeline 视口挂载后观察并先 measure 一次；离开 timeline / unmount 时断开，
// 防止窗口尺寸变化后 viewportH 过期、虚拟列表渲染错误行数或空白。
function bindTimelineViewport(el) {
  if (typeof ResizeObserver === "undefined" || !el) return;
  if (ro) ro.disconnect(); // 不在过期元素上重复 observer
  ro = new ResizeObserver(() => measure());
  ro.observe(el);
  measure(); // 挂载即先量一次，建立初始 viewportH
}
function unbindTimelineViewport() {
  if (ro) {
    ro.disconnect();
    ro = null;
  }
}

function measure() {
  const el = viewport.value;
  if (!el) return;
  scrollTop.value = el.scrollTop;
  viewportH.value = el.clientHeight;
  atBottom = isAtBottom();
}
function isAtBottom() {
  const el = viewport.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}
function onScroll() {
  measure();
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

// ── 详情导航（层级 3） ──
const prevId = computed(() => adjacentEventId(events.value, selectedEventId.value, -1));
const nextId = computed(() => adjacentEventId(events.value, selectedEventId.value, 1));
const eventPosition = computed(() => {
  const idx = eventIndex(events.value, selectedEventId.value);
  return idx >= 0 ? `${idx + 1} / ${events.value.length}` : "-";
});

function selectEvent(id) {
  selectedEventId.value = id;
  nextTick(() => {
    const el = detailViewport.value;
    if (el) el.scrollTop = 0;
  });
}
function goPrevious() {
  if (prevId.value) selectEvent(prevId.value);
}
function goNext() {
  if (nextId.value) selectEvent(nextId.value);
}

// ── 层级跳转 ──
function captureTimelineScroll() {
  const el = viewport.value;
  if (el && selectedId.value != null) scrollMap[selectedId.value] = el.scrollTop;
}
// 恢复存储的 scrollTop；无记录则跟随底部。绝不主动触发新的 bottom-follow。
function restoreTimelineScroll() {
  nextTick(() => {
    const el = viewport.value;
    if (!el) return;
    bindTimelineViewport(el);
    const stored = selectedId.value != null ? scrollMap[selectedId.value] : undefined;
    if (typeof stored === "number") {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.max(0, Math.min(stored, max));
      measure();
    } else {
      scrollToBottom();
    }
  });
}

// agents -> timeline：新 worker 跟随底部；重入同一 worker 恢复其阅读位置
function select(id) {
  selectedId.value = id;
  selectedEventId.value = null;
  viewLevel.value = "timeline";
  restoreTimelineScroll();
}

// timeline -> event：记录当前流位置后进入详情
function openEvent(id) {
  captureTimelineScroll();
  unbindTimelineViewport(); // 离开 timeline：断开视口观察
  selectedEventId.value = id;
  viewLevel.value = "event";
  nextTick(() => {
    const el = detailViewport.value;
    if (el) el.scrollTop = 0;
  });
}

// event -> timeline：恢复进入详情前的流位置，不强制 bottom follow
function backToTimeline() {
  selectedEventId.value = null;
  viewLevel.value = "timeline";
  restoreTimelineScroll();
}

// timeline -> agents：保留 selected worker，供稳定重入
function backToAgents() {
  captureTimelineScroll();
  unbindTimelineViewport(); // 离开 timeline：断开视口观察
  viewLevel.value = "agents";
}

// ── 展示辅助 ──
function statusIcon(s) {
  return { starting: "…", running: "▶", success: "✓", failed: "✗", aborted: "■", timeout: "⏱" }[s] || "○";
}
function statusLabel(s) {
  return { starting: "启动中", running: "执行中", success: "成功", failed: "失败", aborted: "中止", timeout: "超时" }[s] || s;
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
  if (ev.type === "terminal") return ev.stream === "stderr" ? "✗" : "▸";
  if (ev.type === "supplement") return "✉";
  const m = { starting: "●", running: "●", success: "✓", failed: "✗", aborted: "■", timeout: "⏱", truncated: "…" };
  return m[ev.state] || "●";
}
function eventColor(ev) {
  if (ev.type === "assistant") return "#7aa2f7";
  if (ev.type === "tool") return ev.ok === false ? "#f7768e" : ev.ok === true ? "#9ece6a" : "#e0af68";
  if (ev.type === "terminal") return ev.stream === "stderr" ? "#f7768e" : "#a9b1d6";
  if (ev.type === "supplement") return "#7dcfff";
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
  if (ev.type === "terminal") {
    const t = (ev.text || "").replace(/\s+/g, " ").trim();
    const label = ev.stream === "stderr" ? "stderr" : "终端输出";
    return t ? `${label} · ${t.slice(0, 48)}` : label;
  }
  if (ev.type === "supplement") {
    const t = (ev.text || "").replace(/\s+/g, " ").trim();
    return t ? `补充 · ${t.slice(0, 48)}` : "补充指令";
  }
  return lifecycleLabel(ev.state) + (ev.message ? " · " + ev.message : "");
}
function detailTitle(ev) {
  if (ev.type === "tool") return `工具 ${ev.tool}`;
  if (ev.type === "assistant") return "助手回复";
  if (ev.type === "terminal") return ev.stream === "stderr" ? "stderr" : "终端输出";
  if (ev.type === "supplement") return "补充指令";
  return `生命周期 · ${lifecycleLabel(ev.state)}`;
}

// ── 轮询 ──
// selection 归一化与 timeline 自动跟随判定均来自纯模块 subagent-navigation.js；
// 这里只保留 DOM 相关副作用（unbind / restore scroll / follow / measure）。
async function poll() {
  try {
    const raw = await window.go.main.App.GetSubagentStatus();
    const data = JSON.parse(raw);
    if (!Array.isArray(data.workers)) return;

    // 刷新前捕获：follow 判定必须取 worker 替换前的真实底部位置，避免被
    // replacement 后的 measure（ResizeObserver / scroll 回调）意外改写。
    const fromLevel = viewLevel.value;
    const prevAtBottom = atBottom;

    workers.value = data.workers;

    const next = reconcileNavigation(
      { viewLevel: viewLevel.value, selectedId: selectedId.value, selectedEventId: selectedEventId.value },
      workers.value
    );

    // 先用“旧 level -> 新 level”的 transition 判断是否离开 timeline，再覆盖
    // viewLevel；若先覆盖，timeline 视口会在卸载前漏解绑 ResizeObserver。
    if (fromLevel === "timeline" && next.viewLevel !== "timeline") {
      unbindTimelineViewport();
    }
    viewLevel.value = next.viewLevel;
    selectedId.value = next.selectedId;
    selectedEventId.value = next.selectedEventId;

    if (next.viewLevel === "timeline" && next.selectedId != null) {
      if (fromLevel === "event") {
        // worker 留存、事件消失：reconcile 已归一化回 timeline，等 DOM 渲染出
        // viewport 后恢复原阅读位置（不触发新的 bottom-follow）。
        await nextTick();
        restoreTimelineScroll();
      } else if (fromLevel === "timeline") {
        await nextTick();
        // 仅当读取者原本在底部时才自动跟随；上滚过则冻结原位（measure 保持位置）
        if (
          shouldFollowTimeline({
            viewLevel: next.viewLevel,
            selectedId: next.selectedId,
            workers: workers.value,
            atBottom: prevAtBottom,
          })
        ) {
          scrollToBottom();
        } else {
          measure();
        }
      }
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
  // 初始为 agents 层时 viewport 为 null（bind 内为空操作）；防御性绑定，保证
  // 若初始即 timeline 也正确挂载观察。
  bindTimelineViewport(viewport.value);
  timer = setInterval(poll, 1000);
});
onUnmounted(() => {
  clearInterval(timer);
  unbindTimelineViewport();
});
</script>

<style scoped>
/* ── 布局（对齐 ManagerView 配色骨架） ── */
.app { height: 100vh; background: #1a1a2e; color: #e0e0e0; display: flex; flex-direction: column; }
section { min-height: 0; }

/* ── 层级 1：Agent 列表 ── */
.agents-view { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.agents-header { padding: 10px 14px; border-bottom: 1px solid #2a2a4a; }
.agents-title-row { display: flex; justify-content: space-between; align-items: center; }
.agents-title-row h1 { font-size: 14px; color: #7aa2f7; margin: 0; }
.count-badge { font-size: 11px; color: #565f89; }
.feedback-toggle { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11px; color: #a9b1d6; cursor: pointer; }
.feedback-toggle input { accent-color: #e0af68; cursor: pointer; }
.note { font-size: 10px; color: #565f89; margin: 6px 0 0; line-height: 1.4; }

.worker-list { flex: 1; overflow-y: auto; }
.agent-item { padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #1a1a3e; display: flex; align-items: center; gap: 6px; border-left: 3px solid transparent; }
.agent-item:hover { background: #16213e; }
.agent-item.active { background: #1a2a4a; border-left-color: #7aa2f7; }
.status-icon { font-size: 14px; flex-shrink: 0; }
.worker-info { flex: 1; min-width: 0; }
.worker-title { font-size: 12px; font-weight: 500; line-height: 1.3; word-break: break-word; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.worker-id { font-size: 10px; color: #565f89; }
.row-chevron { color: #565f89; font-size: 14px; flex-shrink: 0; }
.empty-list { padding: 20px; text-align: center; color: #565f89; font-size: 13px; }

/* ── 顶部栏（层级 2 / 3 共用） ── */
.top-bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #2a2a4a; flex-shrink: 0; }
.back-btn { width: 28px; height: 28px; flex-shrink: 0; border: 1px solid #2a2a4a; border-radius: 4px; background: transparent; color: #a9b1d6; font-size: 20px; line-height: 1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.back-btn:hover { background: #16213e; color: #c0caf5; }
.top-info { flex: 1; min-width: 0; }
.top-info h2 { font-size: 14px; color: #c0caf5; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top-meta { font-size: 11px; color: #565f89; margin-top: 2px; display: flex; gap: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top-meta .crumb { color: #565f89; }
.follow-hint { flex-shrink: 0; font-size: 10px; color: #9ece6a; }
.follow-hint.off { color: #e0af68; }

/* ── 层级 2：时间线（固定行高虚拟滚动，全宽） ── */
.timeline-view { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.timeline-viewport { flex: 1; overflow-y: auto; min-height: 0; }
.timeline-row { height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px; cursor: pointer; border-left: 3px solid transparent; border-bottom: 1px solid #16162a; font-size: 12px; user-select: none; }
.timeline-row:hover { background: #16213e; }
.tl-icon { flex-shrink: 0; width: 16px; text-align: center; font-size: 12px; }
.tl-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #c0caf5; }
.tl-ts { flex-shrink: 0; font-size: 10px; color: #565f89; font-family: monospace; }
.tl-spacer { flex-shrink: 0; }
.tl-empty { padding: 20px; text-align: center; color: #565f89; font-size: 12px; }

/* ── 层级 3：事件详情 ── */
.event-view { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.detail-body { flex: 1; overflow-y: auto; min-height: 0; padding: 14px 16px 72px; }
.detail-field { margin-bottom: 14px; }
.detail-field label { display: block; font-size: 10px; color: #565f89; text-transform: uppercase; margin-bottom: 4px; }
.detail-field pre { margin: 0; background: #0d0d1a; border: 1px solid #16162a; border-radius: 4px; padding: 8px 10px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: #c0caf5; }
.detail-field pre.err { color: #f7768e; }
.detail-field .ok { color: #9ece6a; font-size: 12px; }
.detail-field .err { color: #f7768e; font-size: 12px; }
.assistant-text { max-height: none; }

/* 固定底栏：flex 兄弟节点，detail-body 滚动时保持原位 */
.detail-bar { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border-top: 1px solid #2a2a4a; background: #1a1a2e; }
.nav-btn { border: 1px solid #2a2a4a; background: transparent; color: #a9b1d6; font-size: 12px; border-radius: 4px; padding: 5px 12px; cursor: pointer; }
.nav-btn:hover:not(:disabled) { background: #16213e; color: #c0caf5; }
.nav-btn:disabled { opacity: 0.4; cursor: default; }
.event-position { font-size: 11px; color: #565f89; font-family: monospace; }

.empty-detail { padding: 20px; text-align: center; color: #565f89; font-size: 13px; }

/* ── 补充指令 composer（层级 3，detail-body 与 detail-bar 之间） ──
   颜色语义：蓝=active 动作、琥珀=queued/pending、灰=terminal/copy；无卡片嵌套。 */
.supplement-composer { flex-shrink: 0; border-top: 1px solid #2a2a4a; background: #16162e; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; max-height: 42%; overflow-y: auto; }
.comp-row { display: flex; }
.comp-textarea { flex: 1; width: 100%; background: #0d0d1a; border: 1px solid #2a2a4a; border-radius: 4px; color: #c0caf5; font-size: 12px; font-family: inherit; line-height: 1.5; padding: 6px 8px; resize: vertical; min-height: 44px; }
.comp-textarea:focus { outline: none; border-color: #3b82f6; }
.comp-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.comp-btn { border: 1px solid transparent; border-radius: 4px; font-size: 12px; padding: 5px 12px; cursor: pointer; }
.comp-btn:disabled { opacity: 0.45; cursor: default; }
.comp-btn-blue { background: #2563eb; color: #fff; }
.comp-btn-blue:hover:not(:disabled) { background: #3b82f6; }
.comp-btn-amber { background: transparent; border-color: #e0af68; color: #e0af68; }
.comp-btn-amber:hover:not(:disabled) { background: #e0af6822; }
.comp-btn-amber-outline { background: transparent; border-color: #e0af68; color: #e0af68; }
.comp-btn-amber-outline:hover:not(:disabled) { background: #e0af6822; }
.comp-btn-gray { background: #4b5563; color: #e5e7eb; }
.comp-btn-gray:hover:not(:disabled) { background: #6b7280; }
.comp-btn-mini { padding: 2px 8px; font-size: 11px; flex-shrink: 0; }
.comp-feedback { font-size: 11px; }
.comp-feedback-ok { color: #9ece6a; }
.comp-feedback-err { color: #f7768e; }
.comp-terminal-note { font-size: 11px; color: #565f89; margin: 0; line-height: 1.5; }
.comp-queue { display: flex; flex-direction: column; gap: 4px; }
.comp-entry { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; border-left: 3px solid transparent; font-size: 12px; }
.comp-entry-pending { border-left-color: #e0af68; background: #1a1a2e; }
.comp-entry-handoff { border-left-color: #565f89; background: transparent; }
.comp-entry-idx { flex-shrink: 0; font-size: 10px; color: #565f89; font-family: monospace; width: 14px; text-align: right; }
.comp-entry-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #c0caf5; }
.comp-entry-handoff .comp-entry-text { color: #888; }
.comp-entry-state { flex-shrink: 0; font-size: 10px; color: #565f89; }
.comp-merge-row { justify-content: flex-end; }
.comp-merge-count { font-size: 10px; color: #565f89; }
.supplement-text { color: #7dcfff; }
</style>
