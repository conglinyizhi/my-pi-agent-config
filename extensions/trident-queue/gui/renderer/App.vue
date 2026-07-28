<template>
  <div v-if="initData" class="app">
    <header class="header">
      <h1>⚓ 三叉戟 · 模型路由配置</h1>
      <div class="sub">{{ allModels.length }} 个可用模型</div>
    </header>

    <div class="filters">
      <input v-model="search" placeholder="grep 搜索模型...（支持正则，如 claude|gemini）" class="search-box">
      <select v-model="providerFilter" class="provider-select">
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
        <select v-model="selected[role.name]" class="model-select">
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
      <button class="btn btn-cancel" @click="cancel">取消</button>
      <button class="btn btn-save" @click="save">保存配置</button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import "../../../../lib/gui-theme.css";
import { ref, computed, onMounted } from "vue";

const initData = (window as any).__INIT_DATA__ || {};
const allModels: { value: string; name: string }[] = initData.models || [];
const initialRoles: Record<string, string> = initData.roles || {};
const responseFile: string = initData.responseFile || "";
const fs = (window as any).require("fs");

const search = ref("");
const providerFilter = ref("");
const selected = ref<Record<string, string>>({ ...initialRoles });

const roleNames = [
  { name: "oc", desc: "OC Agent — 跟你聊天的入口" },
  { name: "translator", desc: "翻译工具 — 与OC不同厂商" },
  { name: "planner", desc: "任务拆解 — 架构决策" },
  { name: "worker", desc: "执行层 — 便宜即可" },
  { name: "reviewer", desc: "审查层 — 便宜即可" },
];

// 按 provider 分组
const grouped = computed(() => {
  const g: Record<string, typeof allModels> = {};
  for (const m of allModels) {
    const prov = m.value.split(":")[0];
    if (!g[prov]) g[prov] = [];
    g[prov].push(m);
  }
  return g;
});

// 可见模型（过滤后）
const visibleModels = computed(() => {
  let result = allModels;
  if (providerFilter.value) {
    result = result.filter(m => m.value.startsWith(providerFilter.value + ":"));
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
  const g: Record<string, typeof allModels> = {};
  for (const m of visibleModels.value) {
    const prov = m.value.split(":")[0];
    if (!g[prov]) g[prov] = [];
    g[prov].push(m);
  }
  return g;
});

function cancel() {
  respond({ cancelled: true });
}

function save() {
  respond({ roles: selected.value });
}

function respond(payload: any) {
  fs.writeFileSync(responseFile, JSON.stringify(payload));
  (window as any).close();
}

onMounted(() => {
  // 初始选中预设值
  for (const rn of roleNames) {
    if (initialRoles[rn.name]) selected.value[rn.name] = initialRoles[rn.name];
  }
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
}
.model-select:focus { outline: none; border-color: #4ec9b0; }

.actions {
  padding: 12px 20px; border-top: 1px solid #2a2a4a;
  display: flex; gap: 10px; justify-content: flex-end; align-items: center;
}
.count { font-size: 12px; color: #777; margin-right: auto; }
.btn {
  padding: 10px 28px; border: none; border-radius: 4px;
  font-size: 14px; cursor: pointer; font-family: inherit;
}
.btn-save { background: #2ecc71; color: #fff; }
.btn-save:hover { background: #27ae60; }
.btn-cancel { background: #555; color: #ccc; }
.btn-cancel:hover { background: #666; }
</style>
