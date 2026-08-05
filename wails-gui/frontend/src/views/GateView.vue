<template>
  <div v-if="ready" class="app">
    <header class="top-bar">
      <div class="top-left">
        <h1>⚠️ 危险命令审计</h1>
        <span v-if="taskId" class="task-badge">📋 {{ taskId }}</span>
      </div>
      <div v-if="highlights.length > 0" class="hl-nav">
        <span class="hl-count">{{ cur + 1 }} / {{ highlights.length }}</span>
        <button data-name="highlight-prev" @click="prev" :disabled="cur<=0" class="hl-btn">◀ 上一个</button>
        <button data-name="highlight-next" @click="next" :disabled="cur>=highlights.length-1" class="hl-btn">下一个 ▶</button>
      </div>
    </header>

    <pre ref="cmdBox" class="cmd-area" v-html="commandHtml" @mouseover="onHover" @mouseout="onLeave"></pre>

    <div v-if="tip" class="tooltip" :style="tipPos">⚠️ {{ tip }}</div>

    <div @click="showRules=!showRules" class="collapse-header" title="点击展开/收起规则">
      {{ showRules ? '▼' : '▶' }} {{ rules.length }} 条规则匹配
    </div>
    <div v-if="showRules" class="collapse-body">
      <div v-for="(r,i) in rules" :key="i" class="rule-row">
        <code class="rule-pattern">{{ r.name }}</code>
        <span v-if="r.matched && r.matched.length" class="rule-matched">{{ r.matched.join(' ') }}</span>
        <span class="rule-tip">{{ r.tip }}</span>
      </div>
    </div>

    <footer class="actions">
      <button data-name="action-deny" @click="denyDirect" class="btn btn-deny">🚫 拒绝</button>
      <button data-name="action-deny-reason" @click="openDialog" class="btn btn-warn">📝 拒绝并说明理由</button>
      <button data-name="action-allow" @click="respond('allow')" class="btn btn-allow">✅ 放行</button>
    </footer>

    <!-- 拒绝理由对话框 -->
    <div v-if="dlg" @click.self="dlg=false" class="overlay">
      <div class="dialog">
        <h2 class="dialog-title">审核意见</h2>
        <div v-for="(r,i) in rules" :key="i" @click="tog(i)" class="dialog-rule" :class="{ flagged: flg.has(i) }">
          <input data-name="rule-check" type="checkbox" :checked="flg.has(i)" class="dialog-check">
          <code class="rule-pattern">{{ r.name }}</code>
          <span v-if="r.matched && r.matched.length" class="rule-matched">{{ r.matched.join(' ') }}</span>
          <span class="rule-tip">{{ r.tip }}</span>
        </div>
        <div v-if="flg.size>0" class="flagged-hint">已标记 {{ flg.size }} 个危险点</div>
        <label class="dialog-label">理由：</label>
        <select data-name="reason-select" v-model="txt" class="dialog-select">
          <option value="">-- 手动输入 --</option>
          <option v-for="r in reasons" :key="r.t" :value="r.content">{{ r.title }}</option>
        </select>
        <textarea data-name="reason-text" v-model="txt" placeholder="拒绝理由..." rows="2" class="dialog-textarea"></textarea>
        <div class="dialog-footer">
          <button data-name="dialog-cancel" @click="dlg=false" class="btn btn-cancel">取消</button>
          <button data-name="dialog-confirm" @click="submit" class="btn btn-deny">确认拒绝</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import "../gui-theme.css";
import { ref, computed, onMounted, nextTick } from "vue";

const ready = ref(false);
const cmd = ref("");
const taskId = ref(null);
const rules = ref([]);

const tip = ref("");
const tipPos = ref({});
const cur = ref(0);
const dlg = ref(false);
const txt = ref("");
const reasons = ref([]);
const flg = ref(new Set());
const showRules = ref(false);
const cmdBox = ref(null);

const highlights = computed(() => {
  const r = [];
  for (const rule of rules.value) {
    // 命中 token 精确子串搜索（替代旧正则高亮，无转义/回溯问题）
    for (const token of rule.matched || []) {
      if (!token) continue;
      let idx = 0;
      while ((idx = cmd.value.indexOf(token, idx)) !== -1) {
        r.push({ s: idx, e: idx + token.length, t: rule.tip, n: rule.name });
        idx += token.length;
      }
    }
  }
  r.sort((a, b) => a.s - b.s);
  // 合并相邻危险块：仅同一规则的 token 在空白/重叠相邻时并为一个红框，
  // 让「rm -rf」「pip install」显示为整体而非碎片；
  // 不同规则即使相邻也保持独立（sudo rm -rf 是两个危险点，各自的理由要能分别 hover/导航）；
  // 不同规则重叠时仍合并（避免嵌套 mark 渲染异常，重叠场景罕见）
  const merged = [];
  for (const g of r) {
    const last = merged[merged.length - 1];
    const sameRule = last && last.n === g.n;
    if (last && (sameRule || g.s <= last.e) && (g.s <= last.e || /^\s*$/.test(cmd.value.slice(last.e, g.s)))) {
      last.e = Math.max(last.e, g.e);
    } else {
      merged.push({ ...g });
    }
  }
  return merged;
});

const commandHtml = computed(() => {
  const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const esa = (s) => s.replace(/&/g,"&amp;").replace(/"/g,"&quot;");
  let h = ""; let p = 0;
  for (let i = 0; i < highlights.value.length; i++) {
    const g = highlights.value[i];
    h += esc(cmd.value.slice(p, g.s));
    h += `<mark class="h" data-i="${i}" data-tip="${esa(g.t)}">${esc(cmd.value.slice(g.s, g.e))}</mark>`;
    p = g.e;
  }
  return h + esc(cmd.value.slice(p));
});

function next() { if (cur.value < highlights.value.length - 1) { cur.value++; scroll(); } }
function prev() { if (cur.value > 0) { cur.value--; scroll(); } }
function scroll() {
  nextTick(() => {
    const ms = cmdBox.value?.querySelectorAll("mark.h") ?? [];
    ms.forEach((m, i) => m.classList.toggle("f", i === cur.value));
    ms[cur.value]?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function onHover(e) {
  const t = e.target;
  if (t.tagName === "MARK" && t.classList.contains("h")) {
    tip.value = t.dataset.tip || "";
    const r = t.getBoundingClientRect();
    tipPos.value = { left: `${r.left}px`, top: `${r.bottom + 4}px` };
  }
}
function onLeave() { tip.value = ""; }
function tog(i) {
  const s = new Set(flg.value);
  s.has(i) ? s.delete(i) : s.add(i);
  flg.value = s;
}
function denyDirect() { respond("deny"); }
function openDialog() { flg.value = new Set(); dlg.value = true; }
function submit() {
  const c = txt.value.trim();
  if (c) svR(c);
  respond("deny", c || undefined, [...flg.value]);
}
async function respond(a, c, f) {
  const p = { action: a };
  if (c) p.comment = c;
  if (f && f.length > 0) p.flagged = f;
  await window.go.main.App.SaveResponse(JSON.stringify(p));
  window.runtime.Quit();
}
async function svR(content) {
  await window.go.main.App.SaveReason(content);
  reasons.value = await window.go.main.App.LoadReasons();
}

onMounted(async () => {
  const data = await window.go.main.App.GetInitData();
  cmd.value = data.command || "";
  taskId.value = data.taskId || null;
  rules.value = data.rules || [];
  reasons.value = await window.go.main.App.LoadReasons();
  ready.value = true;
  await window.go.main.App.MarkReady();
  // 默认高亮第一个命中点，否则「下一个」会从第二个开始（第一个从未被选中）
  scroll();
  // 不设自动超时：用户考虑多久都行；扩展侧有 1 小时兑底，关窗口（X）也会让扩展回退 TUI
});
</script>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; background: #1a1a2e; color: #e0e0e0; }

/* ── 顶部栏 ── */
.top-bar { padding: 8px 16px; border-bottom: 1px solid #2a2a4a; display: flex; justify-content: space-between; align-items: center; }
.top-left { display: flex; align-items: center; gap: 10px; }
.top-left h1 { font-size: 15px; color: #ff6b6b; margin: 0; }
.task-badge { font-size: 11px; color: #7aa2f7; background: #1a1a3e; padding: 2px 8px; border-radius: 4px; }

/* ── 高亮导航 ── */
.hl-nav { display: flex; gap: 6px; align-items: center; font-size: 12px; }
.hl-count { color: #888; }
.hl-btn { padding: 3px 10px; background: #2a2a4a; border: 1px solid #444; border-radius: 3px; color: #ccc; cursor: pointer; font-size: 11px; }
.hl-btn:disabled { opacity: 0.4; }

/* ── 命令展示区 ── */
.cmd-area { flex: 1; margin: 0; padding: 16px; background: #0d0d1a; font-family: monospace; font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-all; overflow-wrap: break-word; overflow: auto; color: #e0e0e0; outline: none; }

/* ── 提示浮窗 ── */
.tooltip { position: fixed; background: #1a1a2e; border: 1px solid #e67e22; padding: 5px 10px; border-radius: 4px; font-size: 12px; color: #e67e22; z-index: 100; pointer-events: none; }

/* ── 规则列表 ── */
.rule-row { padding: 3px 6px; margin-bottom: 2px; border-left: 2px solid #ff6b6b44; display: flex; gap: 6px; }
.rule-pattern { color: #ce9178; background: #0d0d1a; padding: 1px 4px; border-radius: 2px; }
.rule-matched { color: #e67e22; background: #2a1a0a; padding: 1px 4px; border-radius: 2px; font-family: monospace; font-size: 11px; }
.rule-tip { color: #999; }

/* ── 对话框 ── */
.dialog-title { font-size: 14px; color: #ff6b6b; margin: 0 0 8px; }
.dialog-rule { padding: 4px 6px; margin-bottom: 3px; border-radius: 3px; font-size: 11px; cursor: pointer; display: flex; gap: 6px; align-items: center; background: #16213e; border-left: 2px solid #ff6b6b; }
.dialog-rule.flagged { background: #2a1a0a; border-left-color: #e67e22; }
.dialog-check { accent-color: #e67e22; margin: 0; }
.flagged-hint { font-size: 11px; color: #e67e22; margin-bottom: 4px; }
.dialog-label { font-size: 11px; color: #888; display: block; margin: 6px 0 3px; }
.dialog-select {
  width: 100%; padding: 5px 8px; background: #0d0d1a; border: 1px solid #333; border-radius: 3px;
  color: #e0e0e0; font-size: 12px;
  -webkit-appearance: none; appearance: none;
  padding-right: 24px;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 8px center;
}
.dialog-textarea { width: 100%; padding: 5px 8px; background: #0d0d1a; border: 1px solid #333; border-radius: 3px; color: #e0e0e0; font-family: inherit; font-size: 12px; margin-top: 6px; resize: vertical; }
.dialog-footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
</style>

<style>
/* 全局：动态生成的 mark 标签无法 scoped */
mark.h { background:#ff6b6b22; color:#e0e0e0; padding:1px 2px; border-radius:2px; cursor:pointer; transition:all 0.12s; }
mark.h:hover { background:#ff6b6b44; }
mark.h.f { background:#ff6b6b55; outline:1px solid #ff6b6b; color:#ff6b6b; }
</style>
