<template>
  <div v-if="ready" class="app">
    <header class="header">
      <h1>⚓ 三叉戟 · 模型路由配置</h1>
      <div class="sub">{{ allModels.length }} 个可用模型</div>
    </header>

    <div class="filters">
      <input data-name="model-search" v-model="search" placeholder="grep 搜索模型...（支持正则，如 claude|gemini）" class="search-box">
      <select data-name="provider-filter" v-model="providerFilter" class="provider-select">
        <option value="">所有供应商</option>
        <option v-for="(models, prov) in grouped" :key="prov" :value="prov">
          {{ prov }} ({{ models.length }})
        </option>
      </select>
      <span class="hint">Ctrl+F 聚焦搜索</span>
    </div>

    <div class="roles">
      <div v-for="role in roleNames" :key="role.name" class="role-row">
        <div class="role-label">
          <strong>{{ role.name }}</strong>
          <span class="role-desc">{{ role.desc }}</span>
        </div>
        <select :data-name="`model-select-${role.name}`" v-model="selected[role.name]" class="model-select">
          <option v-if="selected[role.name] && !visibleModels.some(m => m.value === selected[role.name])"
            :value="selected[role.name]">{{ selected[role.name] }}（已选）</option>
          <optgroup v-for="(models, prov) in filteredGrouped" :key="prov" :label="prov">
            <option v-for="m in models" :key="m.value" :value="m.value">
              {{ m.value }} — {{ m.name }}
            </option>
          </optgroup>
        </select>
      </div>
    </div>

    <footer class="actions">
      <span class="count">{{ visibleModels.length }} 个匹配</span>
      <button data-name="setup-cancel" class="btn btn-cancel" @click="cancel">取消</button>
      <button data-name="setup-save" class="btn btn-save" @click="save">保存配置</button>
    </footer>
  </div>
</template>

<script setup>
import "./gui-theme.css";
import { ref, computed, onMounted } from "vue";

const ready = ref(false);
const allModels = ref([]);
const initialRoles = ref({});
const selected = ref({});

const search = ref("");
const providerFilter = ref("");

const roleNames = [
  { name: "oc", desc: "主对话 — 聪明模型" },
  { name: "translator", desc: "任务翻译 — 建议与 OC 不同厂商" },
  { name: "worker", desc: "subagent 执行 — 便宜即可" },
];

// 按 provider 分组
const grouped = computed(() => {
  const g = {};
  for (const m of allModels.value) {
    const prov = m.value.split("/")[0];
    if (!g[prov]) g[prov] = [];
    g[prov].push(m);
  }
  return g;
});

// 可见模型（过滤后）
const visibleModels = computed(() => {
  let result = allModels.value;
  if (providerFilter.value) {
    result = result.filter(m => m.value.startsWith(providerFilter.value + "/"));
  }
  if (search.value) {
    try {
      const re = new RegExp(search.value, "i");
      result = result.filter(m => re.test(m.value) || re.test(m.name));
    } catch {
      const q = search.value.toLowerCase();
      result = result.filter(m => m.value.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    }
  }
  return result;
});

const filteredGrouped = computed(() => {
  const g = {};
  for (const m of visibleModels.value) {
    const prov = m.value.split("/")[0];
    if (!g[prov]) g[prov] = [];
    g[prov].push(m);
  }
  return g;
});

async function respond(payload) {
  await window.go.main.App.SaveResponse(JSON.stringify(payload));
  window.runtime.Quit();
}

function cancel() {
  respond({ cancelled: true });
}

function save() {
  respond({ roles: selected.value });
}

onMounted(async () => {
  const data = await window.go.main.App.GetInitData();
  allModels.value = data.models || [];
  initialRoles.value = data.roles || {};
  selected.value = { ...initialRoles.value };
  ready.value = true;
});
</script>

<style scoped>
.app {
  display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  font-family: -apple-system, "Microsoft YaHei", sans-serif;
  background: #1a1a2e; color: #e0e0e0;
}
.header { padding: 16px 20px 8px; border-bottom: 1px solid #2a2a4a; }
.header h1 { font-size: 16px; color: #4ec9b0; margin: 0; }
.header .sub { font-size: 12px; color: #888; margin-top: 4px; }

.filters {
  margin: 8px 20px; display: flex; gap: 10px; align-items: center;
}
.search-box, .provider-select {
  padding: 8px 12px; height: 36px;
  background: #0d0d1a; border: 1px solid #333;
  border-radius: 4px; color: #e0e0e0; font-size: 13px;
  font-family: inherit;
}
.provider-select {
  -webkit-appearance: none; appearance: none;
  padding-right: 26px;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
}
.search-box { flex: 1; }
.search-box:focus, .provider-select:focus { outline: none; border-color: #4ec9b0; }
.hint { font-size: 11px; color: #666; }

.roles { flex: 1; overflow-y: auto; margin: 0 20px; }
.role-row {
  padding: 10px 0; border-bottom: 1px solid #2a2a4a;
  display: flex; gap: 12px; align-items: center;
}
.role-label {
  display: flex; flex-direction: column; min-width: 100px;
}
.role-label strong { font-size: 14px; color: #4ec9b0; }
.role-desc { font-size: 11px; color: #888; margin-top: 2px; }
.model-select {
  flex: 1; padding: 8px 10px;
  background: #0d0d1a; border: 1px solid #333; border-radius: 4px;
  color: #e0e0e0; font-size: 13px; font-family: inherit;
  -webkit-appearance: none; appearance: none;
  padding-right: 26px;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
}
.model-select:focus { outline: none; border-color: #4ec9b0; }

.btn-save { background: #2ecc71; color: #fff; }
.btn-save:hover { background: #27ae60; }
</style>
