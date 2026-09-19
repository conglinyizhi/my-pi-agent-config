<template>
  <div v-if="ready" class="app">
    <header class="header">
      <h1>IM 许可</h1>
      <div class="sub">只在本机授权。把配对码贴进来，或点待授权账号。</div>
    </header>

    <div class="paste">
      <input
        v-model="code"
        data-name="allow-code"
        placeholder="PIHUB-…"
        spellcheck="false"
        @keydown.enter.prevent="grantPasted"
      >
      <button class="btn btn-allow" data-name="allow-grant" :disabled="!pastedCode" @click="grantPasted">授权</button>
    </div>

    <div class="section-label">待授权 ({{ pairs.length }})</div>
    <div v-if="pairs.length === 0" class="empty">没有待授权账号</div>
    <div v-else class="list">
      <div v-for="pair in pairs" :key="pair.code" class="row">
        <div class="meta">
          <span class="name">{{ pairLabel(pair) }}</span>
          <span class="code">{{ pair.code }}</span>
          <span class="exp">至 {{ pair.expiresAt }}</span>
        </div>
        <button class="btn btn-allow btn-small" data-name="allow-pair" @click="grant(pair.code)">授权</button>
      </div>
    </div>

    <div class="section-label dim">未决审批 ({{ asks.length }})</div>
    <div v-if="asks.length === 0" class="empty dim">没有未决审批</div>
    <div v-else class="list dim">
      <div v-for="ask in asks" :key="ask.requestId" class="row">
        <div class="meta">
          <span class="name">{{ ask.kind }} · {{ ask.command || ask.requestId }}</span>
          <span class="exp">至 {{ ask.expiresAt }}</span>
        </div>
      </div>
    </div>

    <footer class="actions">
      <button class="btn btn-cancel" data-name="allow-close" @click="close">关闭</button>
    </footer>
  </div>
</template>

<script setup>
import "../gui-theme.css";
import { computed, onMounted, ref } from "vue";
import { usePlatform } from "../platform/index.js";
import { pairLabel } from "../domain/allowlist/pairs.js";

const platform = usePlatform();
const ready = ref(false);
const pairs = ref([]);
const asks = ref([]);
const code = ref("");
const pastedCode = computed(() => code.value.trim());

async function grant(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) return;
  await platform.session.submit({ code: trimmed });
  await platform.session.close();
}

function grantPasted() {
  return grant(pastedCode.value);
}

async function close() {
  await platform.session.close();
}

onMounted(async () => {
  const data = await platform.session.getInitData();
  pairs.value = data.pairs || [];
  asks.value = data.asks || [];
  ready.value = true;
  await platform.session.markReady();
});
</script>

<style scoped>
.app { padding: 16px 20px 12px; color: var(--text); font-family: var(--font); min-height: 100vh; background: var(--bg); display: flex; flex-direction: column; gap: 12px; }
.header h1 { margin: 0; font-size: 18px; }
.sub { color: var(--text-dim); font-size: 12px; margin-top: 4px; }
.paste { display: flex; gap: 8px; }
.paste input { flex: 1; background: var(--bg-alt); border: 1px solid var(--border); color: var(--text); padding: 8px 10px; border-radius: var(--radius); font-family: var(--mono); }
.section-label { font-size: 12px; color: var(--accent); }
.section-label.dim, .empty.dim, .list.dim { color: var(--text-dim); }
.empty { font-size: 13px; color: var(--text-dim); }
.list { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; }
.meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name { font-size: 13px; }
.code, .exp { font-size: 11px; color: var(--text-dim); font-family: var(--mono); }
.actions { margin-top: auto; display: flex; justify-content: flex-end; }
</style>
