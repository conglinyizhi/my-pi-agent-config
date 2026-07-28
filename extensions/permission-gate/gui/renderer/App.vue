<template>
  <div v-if="initData" class="gate">
    <header class="header">
      <h1>⚠️ 危险命令审计</h1>
      <div class="sub">{{ rules.length }} 条规则匹配</div>
    </header>

    <pre class="command-box" v-html="commandHtml"></pre>

    <div class="rules">
      <h2>命中规则</h2>
      <div v-for="(rule, i) in rules" :key="i" class="rule" :style="{ animationDelay: i * 0.05 + 's' }">
        <span :class="['badge', rule.autoReject ? 'auto' : 'warn']">
          {{ rule.autoReject ? '自动拒绝' : '需确认' }}
        </span>
        <span class="pattern"><code>{{ rule.pattern }}</code></span>
        <span class="tip">{{ rule.tip }}</span>
      </div>
    </div>

    <footer class="actions">
      <span class="count">{{ rules.length }} 条规则匹配</span>
      <button class="btn btn-deny" @click="showDenyDialog">❌ 拒绝</button>
      <button class="btn btn-allow" @click="respond('allow')">✅ 允许执行</button>
    </footer>

    <!-- 拒绝弹层 -->
    <div v-if="denyDialogOpen" class="overlay" @click.self="denyDialogOpen = false">
      <div class="dialog">
        <h2>审核意见</h2>
        <label>常用理由：</label>
        <select v-model="denyReason" @change="onReasonSelect">
          <option value="">-- 手动输入 --</option>
          <option v-for="r in reasons" :key="r" :value="r">{{ r.slice(0, 80) }}</option>
        </select>
        <label>审核意见（可选）：</label>
        <textarea v-model="denyReason" placeholder="输入拒绝理由（可选）..." rows="3"></textarea>
        <div class="dialog-btns">
          <button class="btn btn-cancel" @click="denyDialogOpen = false">取消</button>
          <button class="btn btn-deny" @click="submitDeny">确认拒绝</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";

const initData = (window as any).__INIT_DATA__ || {};
const command: string = initData.command || "";
const rules: any[] = initData.rules || [];
const responseFile: string = initData.responseFile || "";
const fs = (window as any).require("fs");
const TIMEOUT_MS = 120_000;

// ── 高亮 ──
const commandHtml = computed(() => {
  const highlights: [number, number][] = [];
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.pattern, "gi");
      let m;
      while ((m = re.exec(command)) !== null) {
        highlights.push([m.index, m.index + m[0].length]);
        if (m[0].length === 0) break;
      }
    } catch {}
  }
  highlights.sort((a, b) => a[0] - b[0]);

  // 合并重叠区间
  const merged: [number, number][] = [];
  for (const [s, e] of highlights) {
    let end = e;
    while (merged.length > 0 && merged[merged.length - 1][1] >= s) {
      const prev = merged.pop()!;
      end = Math.max(end, prev[1]);
    }
    merged.push([s, end]);
  }

  let html = "";
  let pos = 0;
  for (const [s, e] of merged) {
    html += escHtml(command.slice(pos, s));
    html += `<mark>${escHtml(command.slice(s, e))}</mark>`;
    pos = e;
  }
  html += escHtml(command.slice(pos));
  return html;
});

// ── 理由 ──
const reasons = ref<string[]>([]);
const denyReason = ref("");
const denyDialogOpen = ref(false);

function loadReasons() {
  const p = (window as any).require("path").join((window as any).require("os").homedir(), ".pi", "agent", "permission-gate-reasons.json");
  try {
    if (fs.existsSync(p)) {
      reasons.value = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
  } catch {}
}

function saveReason(reason: string) {
  const r = reasons.value.filter((x: string) => x !== reason);
  r.unshift(reason);
  if (r.length > 20) r.length = 20;
  const p = (window as any).require("path").join((window as any).require("os").homedir(), ".pi", "agent", "permission-gate-reasons.json");
  try {
    (window as any).require("fs").mkdirSync((window as any).require("path").dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(r, null, 2));
  } catch {}
}

function onReasonSelect() {
  if (denyReason.value) {
    // already set via v-model
  }
}

function showDenyDialog() {
  denyDialogOpen.value = true;
}

function submitDeny() {
  const comment = denyReason.value.trim();
  if (comment) saveReason(comment);
  respond("deny", comment || undefined);
}

function respond(action: string, comment?: string) {
  fs.writeFileSync(responseFile, JSON.stringify({ action, comment }));
  (window as any).close();
}

// ── 超时 ──
let timeoutId: ReturnType<typeof setTimeout> | null = null;
onMounted(() => {
  loadReasons();
  timeoutId = setTimeout(() => respond("timeout"), TIMEOUT_MS);
});
onUnmounted(() => {
  if (timeoutId) clearTimeout(timeoutId);
});

function escHtml(s: string) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
</script>

<style scoped>
.gate {
  display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  font-family: -apple-system, "Microsoft YaHei", sans-serif;
  background: #1a1a2e; color: #e0e0e0;
}
.header { padding: 16px 20px 8px; border-bottom: 1px solid #2a2a4a; }
.header h1 { font-size: 16px; color: #ff6b6b; margin: 0; }
.header .sub { font-size: 12px; color: #888; margin-top: 4px; }

.command-box {
  margin: 12px 20px; padding: 14px 16px;
  background: #0d0d1a; border: 1px solid #333; border-radius: 6px;
  font-family: "JetBrains Mono", monospace;
  font-size: 13px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-all;
  overflow-y: auto; max-height: 200px; color: #4ec9b0;
}
.command-box :deep(mark) {
  background: #ff6b6b44; color: #ff6b6b;
  padding: 1px 0; border-radius: 2px; font-weight: bold;
}

.rules { flex: 1; overflow-y: auto; margin: 0 20px; }
.rules h2 { font-size: 13px; color: #aaa; margin: 8px 0 6px; }
.rule {
  padding: 8px 12px; margin-bottom: 6px;
  background: #16213e; border-radius: 4px;
  border-left: 3px solid #ff6b6b;
  display: flex; gap: 10px; align-items: baseline;
  animation: fadeIn 0.2s ease-out both;
}
@keyframes fadeIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }
.badge {
  font-size: 10px; padding: 1px 6px; border-radius: 3px;
  white-space: nowrap; flex-shrink: 0;
}
.badge.warn { background: #ff6b6b33; color: #ff6b6b; }
.badge.auto { background: #ff444455; color: #ff4444; }
.pattern { font-size: 12px; flex-shrink: 0; }
.pattern code { color: #ce9178; background: #1a1a2e; padding: 1px 4px; border-radius: 2px; }
.tip { font-size: 12px; color: #999; }

.actions {
  padding: 12px 20px; border-top: 1px solid #2a2a4a;
  display: flex; gap: 10px; justify-content: flex-end; align-items: center;
}
.count { font-size: 12px; color: #777; margin-right: auto; }

.btn {
  padding: 10px 28px; border: none; border-radius: 4px;
  font-size: 14px; cursor: pointer; font-family: inherit;
}
.btn-allow { background: #2ecc71; color: #fff; }
.btn-allow:hover { background: #27ae60; }
.btn-deny { background: #e74c3c; color: #fff; }
.btn-deny:hover { background: #c0392b; }
.btn-cancel { background: #555; color: #ccc; }
.btn-cancel:hover { background: #666; }

.overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; justify-content: center; align-items: center; z-index: 100;
}
.dialog {
  background: #1a1a2e; border: 1px solid #333; border-radius: 8px;
  padding: 24px; width: 90%; max-width: 600px;
}
.dialog h2 { font-size: 15px; color: #ff6b6b; margin-bottom: 12px; }
.dialog label { font-size: 12px; color: #888; display: block; margin: 10px 0 4px; }
.dialog select, .dialog textarea {
  width: 100%; padding: 8px 10px;
  background: #0d0d1a; border: 1px solid #333; border-radius: 4px;
  color: #e0e0e0; font-family: inherit; font-size: 13px;
}
.dialog textarea { resize: vertical; }
.dialog-btns { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.dialog-btns .btn { padding: 8px 20px; font-size: 13px; }
</style>
