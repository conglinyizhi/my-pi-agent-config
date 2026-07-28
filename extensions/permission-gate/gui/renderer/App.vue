<template>
  <div v-if="!initData" style="color:red;padding:20px">initData 为空</div>
  <div v-else style="display:flex;flex-direction:column;height:100vh;background:#1a1a2e;color:#e0e0e0">
    <header style="padding:8px 16px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center">
      <h1 style="font-size:15px;color:#ff6b6b;margin:0">⚠️ 危险命令审计</h1>
      <div v-if="highlights.length > 0" style="display:flex;gap:6px;align-items:center;font-size:12px">
        <span style="color:#888">{{ cur + 1 }} / {{ highlights.length }}</span>
        <button @click="prev" :disabled="cur<=0" style="padding:3px 10px;background:#2a2a4a;border:1px solid #444;border-radius:3px;color:#ccc;cursor:pointer;font-size:11px;disabled:opacity:0.4">◀ 上一个</button>
        <button @click="next" :disabled="cur>=highlights.length-1" style="padding:3px 10px;background:#2a2a4a;border:1px solid #444;border-radius:3px;color:#ccc;cursor:pointer;font-size:11px">下一个 ▶</button>
      </div>
    </header>

    <pre ref="cmdBox" style="flex:1;margin:0;padding:16px;background:#0d0d1a;font-family:monospace;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-all;overflow-wrap:break-word;overflow:auto;color:#e0e0e0;outline:none"
      v-html="commandHtml" @mouseover="onHover" @mouseout="onLeave"></pre>

    <div v-if="tip" style="position:fixed;background:#1a1a2e;border:1px solid #e67e22;padding:5px 10px;border-radius:4px;font-size:12px;color:#e67e22;z-index:100;pointer-events:none" :style="tipPos">⚠️ {{ tip }}</div>

    <div @click="showRules=!showRules" style="padding:2px 16px;font-size:11px;color:#777;cursor:pointer;border-top:1px solid #2a2a4a" title="点击展开/收起规则">
      {{ showRules ? '▼' : '▶' }} {{ rules.length }} 条规则匹配
    </div>
    <div v-if="showRules" style="padding:4px 16px 8px;background:#16213e;font-size:11px">
      <div v-for="(r,i) in rules" :key="i" style="padding:3px 6px;margin-bottom:2px;border-left:2px solid #ff6b6b44;display:flex;gap:6px">
        <code style="color:#ce9178;background:#0d0d1a;padding:1px 4px;border-radius:2px">{{ r.pattern }}</code>
        <span style="color:#999">{{ r.tip }}</span>
      </div>
    </div>

    <footer style="padding:10px 16px;border-top:1px solid #2a2a4a;display:flex;gap:10px;justify-content:flex-end;align-items:center">
      <button @click="denyDirect" style="padding:10px 24px;border:none;border-radius:4px;font-size:13px;cursor:pointer;background:#e74c3c;color:#fff;font-family:inherit">🚫 拒绝</button>
      <button @click="openDialog" style="padding:10px 24px;border:none;border-radius:4px;font-size:13px;cursor:pointer;background:#e67e22;color:#fff;font-family:inherit">📝 拒绝并说明理由</button>
      <button @click="respond('allow')" style="padding:10px 24px;border:none;border-radius:4px;font-size:13px;cursor:pointer;background:#2ecc71;color:#fff;font-family:inherit">✅ 放行</button>
    </footer>

    <div v-if="dlg" @click.self="dlg=false" style="position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;justify-content:center;align-items:center;z-index:100">
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:16px;width:90%;max-width:500px;max-height:80vh;overflow-y:auto">
        <h2 style="font-size:14px;color:#ff6b6b;margin-bottom:8px">审核意见</h2>
        <div v-for="(r,i) in rules" :key="i" @click="tog(i)" style="padding:4px 6px;margin-bottom:3px;border-radius:3px;font-size:11px;cursor:pointer;display:flex;gap:6px;align-items:center"
          :style="flg.has(i)?'background:#2a1a0a;border-left:2px solid #e67e22':'background:#16213e;border-left:2px solid #ff6b6b'">
          <input type="checkbox" :checked="flg.has(i)" style="accent-color:#e67e22;margin:0">
          <code style="color:#ce9178;background:#0d0d1a;padding:1px 4px;border-radius:2px">{{ r.pattern }}</code>
          <span style="color:#999;flex:1">{{ r.tip }}</span>
        </div>
        <div v-if="flg.size>0" style="font-size:11px;color:#e67e22;margin-bottom:4px">已标记 {{ flg.size }} 个危险点</div>
        <label style="font-size:11px;color:#888;display:block;margin:6px 0 3px">理由：</label>
        <select v-model="txt" style="width:100%;padding:5px 8px;background:#0d0d1a;border:1px solid #333;border-radius:3px;color:#e0e0e0;font-family:inherit;font-size:12px">
          <option value="">-- 手动输入 --</option>
          <option v-for="r in reasons" :key="r" :value="r">{{ r.slice(0,80) }}</option>
        </select>
        <textarea v-model="txt" placeholder="拒绝理由..." rows="2" style="width:100%;padding:5px 8px;background:#0d0d1a;border:1px solid #333;border-radius:3px;color:#e0e0e0;font-family:inherit;font-size:12px;margin-top:6px;resize:vertical"></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
          <button @click="dlg=false" style="padding:6px 14px;border:none;border-radius:4px;font-size:12px;cursor:pointer;background:#555;color:#ccc;font-family:inherit">取消</button>
          <button @click="submit" style="padding:6px 14px;border:none;border-radius:4px;font-size:12px;cursor:pointer;background:#e74c3c;color:#fff;font-family:inherit">确认拒绝</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";

const $ = (window as any).__INIT_DATA__;
const initData = !!$;
const cmd = $?.command || "";
const rules = $?.rules || [];
const rsp = $?.responseFile || "";
const fs = (window as any).require("fs");

const tip = ref("");
const tipPos = ref({});
const cur = ref(0);
const dlg = ref(false);
const txt = ref("");
const reasons = ref<string[]>([]);
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
  const p = (window as any).require("path").join((window as any).require("os").homedir(), ".pi", "agent", "permission-gate-reasons.json");
  try { if (fs.existsSync(p)) reasons.value = JSON.parse(fs.readFileSync(p, "utf-8")); } catch {}
}
function svR(r: string) { const rs = reasons.value.filter((x: string) => x !== r); rs.unshift(r); if (rs.length > 20) rs.length = 20;
  const p = (window as any).require("path").join((window as any).require("os").homedir(), ".pi", "agent", "permission-gate-reasons.json");
  try { (window as any).require("fs").mkdirSync((window as any).require("path").dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(rs, null, 2)); } catch {} }

onMounted(() => { ldR(); setTimeout(() => respond("timeout"), 120_000); });
</script>

<style>
mark.h { background:#ff6b6b22; color:#e0e0e0; padding:1px 2px; border-radius:2px; cursor:pointer; transition:all 0.12s; }
mark.h:hover { background:#ff6b6b44; }
mark.h.f { background:#ff6b6b55; outline:1px solid #ff6b6b; color:#ff6b6b; }
</style>
