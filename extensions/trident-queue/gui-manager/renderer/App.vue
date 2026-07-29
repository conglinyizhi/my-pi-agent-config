<template>
  <div v-if="!initData" style="color:red;padding:20px">initData 为空</div>
  <div v-else style="display:flex;height:100vh;background:#1a1a2e;color:#e0e0e0">
    <!-- 左侧任务列表 -->
    <div style="width:280px;border-right:1px solid #2a2a4a;display:flex;flex-direction:column;overflow:hidden">
      <header style="padding:10px 14px;border-bottom:1px solid #2a2a4a">
        <h1 style="font-size:14px;color:#7aa2f7;margin:0">⚓ 舰队事项</h1>
        <div style="font-size:11px;color:#666;margin-top:2px">{{ tasks.length }} 个任务</div>
      </header>
      <div style="flex:1;overflow-y:auto">
        <div v-for="t in tasks" :key="t.id" @click="select(t.id)" :style="{
          padding:'12px 14px',cursor:'pointer',borderBottom:'1px solid #1a1a3e',
          background: selectedId===t.id ? '#1a2a4a' : 'transparent',
          borderLeft: selectedId===t.id ? '3px solid #7aa2f7' : '3px solid transparent'
        }">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
            <span style="font-size:14px">{{ statusIcon(t.status) }}</span>
            <span :style="{color: statusColor(t.status),fontSize:'11px',fontWeight:'600'}">{{ statusLabel(t.status) }}</span>
          </div>
          <div style="font-size:13px;font-weight:500;line-height:1.3;word-break:break-word">{{ t.title }}</div>
          <div style="font-size:10px;color:#565f89;margin-top:4px">{{ t.id }}</div>
        </div>
        <div v-if="tasks.length===0" style="padding:20px;text-align:center;color:#565f89;font-size:13px">
          暂无事项
        </div>
      </div>
    </div>

    <!-- 右侧详情 -->
    <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
      <template v-if="selected">
        <header style="padding:10px 16px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center">
          <div>
            <h2 style="font-size:15px;color:#c0caf5;margin:0">{{ selected.title }}</h2>
            <div style="font-size:11px;color:#666;margin-top:2px">
              {{ selected.id }} · {{ new Date(selected.created_at).toLocaleString("zh-CN") }}
            </div>
          </div>
          <button v-if="selected.status==='executing'" @click="killTask" data-name="action-kill"
            style="padding:6px 16px;background:#f7768e;color:#1a1b26;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">
            ⏹ 终止
          </button>
        </header>

        <div style="flex:1;overflow-y:auto;padding:16px">
          <div style="margin-bottom:16px">
            <label style="font-size:11px;color:#666;text-transform:uppercase">状态</label>
            <div :style="{color:statusColor(selected.status),fontSize:'14px',fontWeight:'600'}">
              {{ statusLabel(selected.status) }}
            </div>
          </div>
          <div>
            <label style="font-size:11px;color:#666;text-transform:uppercase">详细内容</label>
            <pre style="background:#0d0d1a;padding:14px;border-radius:6px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:4px 0 0;max-height:calc(100vh - 260px);overflow-y:auto">{{ selected.context }}</pre>
          </div>
        </div>
      </template>
      <div v-else style="flex:1;display:flex;align-items:center;justify-content:center;color:#565f89;font-size:14px">
        选择左侧任务查看详情
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import "../../../../lib/gui-theme.css";
import { ref, computed } from "vue";

const $ = (window as any).__INIT_DATA__;
const initData = !!$;
const tasks = ($?.tasks || []) as Array<{
  id: string; title: string; status: string; created_at: string; context: string;
}>;
const rsp = $?.responseFile || "";
const fs = (window as any).require("fs");

const selectedId = ref<string | null>(null);

const selected = computed(() => {
  if (!selectedId.value) return null;
  return tasks.find((t) => t.id === selectedId.value) || null;
});

function select(id: string) { selectedId.value = id; }

function statusIcon(s: string) {
  const map: Record<string, string> = { pending: "○", executing: "▶", done: "✓", blocked: "⏸" };
  return map[s] || "○";
}

function statusColor(s: string) {
  const map: Record<string, string> = { pending: "#7aa2f7", executing: "#9ece6a", done: "#565f89", blocked: "#e0af68" };
  return map[s] || "#565f89";
}

function statusLabel(s: string) {
  const map: Record<string, string> = { pending: "待执行", executing: "执行中", done: "已完成", blocked: "已阻塞" };
  return map[s] || s;
}

function killTask() {
  if (!selected.value) return;
  try {
    fs.writeFileSync(rsp, JSON.stringify({ action: "kill", taskId: selected.value.id }));
  } catch (e) {
    console.error("write response failed", e);
  }
  window.close();
}
</script>
