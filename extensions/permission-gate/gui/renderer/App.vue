<template>
  <div v-if="!initData" class="error-empty">initData 为空</div>
  <div v-else class="app">
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
        <code class="rule-pattern">{{ r.pattern }}</code>
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
          <code class="rule-pattern">{{ r.pattern }}</code>
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

<script setup lang="ts">
import "../../../../lib/gui-theme.css";
import { ref, computed, onMounted, nextTick } from "vue";

const $ = (window as any).__INIT_DATA__;
const initData = !!$;
const cmd = $?.command || "";
const taskId = $?.taskId || null;
const rules = $?.rules || [];
const rsp = $?.responseFile || "";
const fs = (window as any).require("fs");

const tip = ref("");
const tipPos = ref({});
const cur = ref(0);
const dlg = ref(false);
const txt = ref("");
const reasons = ref<ReasonEntry[]>([]);
const flg = ref<Set<number>>(new Set());
const showRules = ref(false);
const cmdBox = ref<HTMLElement | null>(null);

const highlights = computed(() => {
  const r: { s: number; e: number; t: string }[] = [];
  for (const rule of rules) {
    try { const re = new RegExp(rule.pattern, "gi"); let m; while ((m = re.exec(cmd)) !== null) { r.push({ s: m.index, e: m.index + m[0].length, t: rule.tip }); if (m[0].length === 0) break; } } catch {}
  }
  return r.sort((a, b) => a.s - b.s);
});

const commandHtml = computed(() => {
  const esc = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const esa = (s: string) => s.replace(/&/g,"&amp;").replace(/"/g,"&quot;");
  let h = ""; let p = 0;
  for (let i = 0; i < highlights.value.length; i++) {
    const g = highlights.value[i];
    h += esc(cmd.slice(p, g.s));
    h += `<mark class="h" data-i="${i}" data-tip="${esa(g.t)}">${esc(cmd.slice(g.s, g.e))}</mark>`;
    p = g.e;
  }
  return h + esc(cmd.slice(p));
});

function next() { if (cur.value < highlights.value.length - 1) { cur.value++; scroll(); } }
function prev() { if (cur.value > 0) { cur.value--; scroll(); } }
function scroll() {
  nextTick(() => {
    const ms = cmdBox.value?.querySelectorAll("mark.h") ?? [];
    ms.forEach((m, i) => m.classList.toggle("f", i === cur.value));
    (ms[cur.value] as HTMLElement)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function onHover(e: MouseEvent) { const t = e.target as HTMLElement; if (t.tagName === "MARK" && t.classList.contains("h")) { tip.value = t.dataset.tip || ""; const r = t.getBoundingClientRect(); tipPos.value = { left: `${r.left}px`, top: `${r.bottom + 4}px` }; } }
function onLeave() { tip.value = ""; }
function tog(i: number) { const s = new Set(flg.value); s.has(i) ? s.delete(i) : s.add(i); flg.value = s; }
function denyDirect() { respond("deny"); }
function openDialog() { flg.value = new Set(); dlg.value = true; }
function submit() { const c = txt.value.trim(); if (c) svR(c); respond("deny", c || undefined, [...flg.value]); }
function respond(a: string, c?: string, f?: number[]) { const p: any = { action: a }; if (c) p.comment = c; if (f && f.length > 0) p.flagged = f; fs.writeFileSync(rsp, JSON.stringify(p)); (window as any).close(); }

function ldR() {
  const csvPath = (window as any).require("path").join((window as any).require("os").homedir(), ".pi", "agent", "permission-gate-reasons.csv");
  const oldPath = (window as any).require("path").join((window as any).require("os").homedir(), ".pi", "agent", "permission-gate-reasons.json");
  const entries: ReasonEntry[] = [];
  try {
    if (fs.existsSync(oldPath)) {
      const old = JSON.parse(fs.readFileSync(oldPath, "utf-8"));
      for (const r of old) entries.push({ t: new Date().toISOString(), title: r.slice(0, 40), kw: "", content: r });
      fs.rmSync(oldPath);
    }
  } catch {}
  try {
    if (fs.existsSync(csvPath)) {
      const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
      for (let i = 1; i < lines.length; i++) {
        const row = parseCSVRow(lines[i]);
        if (row && row.length >= 4) entries.push({ t: row[0], title: row[1], kw: row[2], content: row[3] });
      }
    }
  } catch {}
  reasons.value = entries;
}

function svR(content: string) {
  const now = new Date().toISOString();
  const title = content.length > 40 ? content.slice(0, 37) + "..." : content;
  const entry: ReasonEntry = { t: now, title, kw: "", content };
  const rs = [entry, ...reasons.value.filter((x: ReasonEntry) => x.content !== content)];
  if (rs.length > 20) rs.length = 20;
  reasons.value = rs;
  const p = (window as any).require("path").join((window as any).require("os").homedir(), ".pi", "agent", "permission-gate-reasons.csv");
  try {
    (window as any).require("fs").mkdirSync((window as any).require("path").dirname(p), { recursive: true });
    let csv = "timestamp,title,keywords,content\n";
    for (const r of rs) csv += `${r.t},"${escCsv(r.title)}","${escCsv(r.kw)}","${escCsv(r.content)}"\n`;
    fs.writeFileSync(p, csv, "utf-8");
  } catch {}
}

function escCsv(s: string) { return String(s).replace(/"/g, '""'); }
function parseCSVRow(line: string): string[] | null {
  if (!line.trim()) return null;
  const fields: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { fields.push(cur); cur = ""; }
      else cur += c;
    }
  }
  fields.push(cur);
  return fields.length === 4 ? fields : null;
}

interface ReasonEntry { t: string; title: string; kw: string; content: string; }

onMounted(() => { ldR(); setTimeout(() => respond("timeout"), 120_000); });
</script>

<style scoped>
/* ── 布局 ── */
.app { display: flex; flex-direction: column; height: 100vh; background: #1a1a2e; color: #e0e0e0; }
.error-empty { color: red; padding: 20px; }

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
.rule-tip { color: #999; }

/* ── 对话框 ── */
.dialog-title { font-size: 14px; color: #ff6b6b; margin: 0 0 8px; }
.dialog-rule { padding: 4px 6px; margin-bottom: 3px; border-radius: 3px; font-size: 11px; cursor: pointer; display: flex; gap: 6px; align-items: center; background: #16213e; border-left: 2px solid #ff6b6b; }
.dialog-rule.flagged { background: #2a1a0a; border-left-color: #e67e22; }
.dialog-check { accent-color: #e67e22; margin: 0; }
.flagged-hint { font-size: 11px; color: #e67e22; margin-bottom: 4px; }
.dialog-label { font-size: 11px; color: #888; display: block; margin: 6px 0 3px; }
.dialog-select { width: 100%; padding: 5px 8px; background: #0d0d1a; border: 1px solid #333; border-radius: 3px; color: #e0e0e0; font-size: 12px; }
.dialog-textarea { width: 100%; padding: 5px 8px; background: #0d0d1a; border: 1px solid #333; border-radius: 3px; color: #e0e0e0; font-family: inherit; font-size: 12px; margin-top: 6px; resize: vertical; }
.dialog-footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
</style>

<style>
/* 全局：动态生成的 mark 标签无法 scoped */
mark.h { background:#ff6b6b22; color:#e0e0e0; padding:1px 2px; border-radius:2px; cursor:pointer; transition:all 0.12s; }
mark.h:hover { background:#ff6b6b44; }
mark.h.f { background:#ff6b6b55; outline:1px solid #ff6b6b; color:#ff6b6b; }
</style>
