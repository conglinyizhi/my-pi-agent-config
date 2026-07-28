<template>
  <div v-if="initData" class="app">
    <header class="header">
      <h1>📋 TODO 调度</h1>
      <div class="sub">{{ todos.length }} 个待处理 / {{ done.length }} 已完成 · 点击方框选中，发送给提督</div>
    </header>

    <!-- 待处理 -->
    <div class="section-label">待处理 ({{ todos.length }})</div>
    <div class="list">
      <div v-for="(item, i) in todos" :key="'p'+i"
        class="todo-row" :class="{ selected: selected.has(i) }"
        @click="toggle(i)">
        <span class="checkbox" data-name="todo-checkbox">{{ selected.has(i) ? '☑' : '☐' }}</span>
        <span class="idx">{{ i + 1 }}</span>
        <span class="loc">{{ item.file }}:{{ item.line }}</span>
        <span class="text">{{ item.text }}</span>
        <button class="btn-loc" data-name="todo-locate" @click.stop="locate(item)" title="用编辑器打开">↗</button>
      </div>
    </div>

    <!-- 已完成 -->
    <div v-if="done.length" class="section-label dim">已完成 ({{ done.length }})</div>
    <div v-if="done.length" class="list dim">
      <div v-for="item in done" :key="'d'+item.file+item.line" class="todo-row done-row">
        <span class="checkbox dim">✓</span>
        <span class="loc dim">{{ item.file }}:{{ item.line }}</span>
        <span class="text dim">{{ item.text }}</span>
        <button class="btn-loc" @click="locate(item)">↗</button>
      </div>
    </div>

    <!-- 补充说明 -->
    <div class="note-area">
      <textarea v-model="note" placeholder="补充说明（可选）…" data-name="todo-note" rows="3"
        @keydown.ctrl.enter="send"></textarea>
    </div>

    <!-- 按钮 -->
    <footer class="actions">
      <span class="count">{{ selectedCount }} 个选中 · Ctrl+Enter 发送</span>
      <button data-name="todo-cancel" class="btn btn-cancel" @click="cancel">取消</button>
      <button data-name="todo-clear" class="btn btn-clear" @click="selected.clear(); note=''">清空</button>
      <button data-name="todo-select-all" class="btn btn-clear" @click="selectAll">{{ allSelected ? '取消全选' : '全选' }}</button>
      <button data-name="todo-send" class="btn btn-allow" :disabled="selectedCount === 0" @click="send">
        {{ selectedCount > 0 ? `发送 (${selectedCount})` : '发送' }}
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import "../../../../lib/gui-theme.css";
import { ref, computed } from "vue";

interface TodoItem { file: string; line: number; text: string; done: boolean; }

const initData = (window as any).__INIT_DATA__ || {};
const raw: TodoItem[] = initData.todos || [];
const responseFile: string = initData.responseFile || "";
const fs = (window as any).require("fs");
const { exec } = (window as any).require("child_process");

const note = ref("");
const selected = ref(new Set<number>());
const selectAllToggle = ref(false);

const todos = computed(() => raw.filter(item => !item.done));
const done = computed(() => raw.filter(item => item.done));
const selectedCount = computed(() => selected.value.size);
const allSelected = computed(() => todos.value.length > 0 && selected.value.size === todos.value.length);

function toggle(i: number) {
  const s = selected.value;
  s.has(i) ? s.delete(i) : s.add(i);
}

function selectAll() {
  if (allSelected.value) { selected.value = new Set(); }
  else { selected.value = new Set(todos.value.map((_, i) => i)); }
}

function locate(item: TodoItem) {
  // 用 code / cursor 打开文件到指定行
  const cmd = `code --goto "${item.file}:${item.line}"`;
  exec(cmd, (err: any) => {
    if (err) {
      exec(`cursor --goto "${item.file}:${item.line}"`, () => {});
    }
  });
}

function send() {
  const indices = [...selected.value].sort((a,b)=>a-b);
  const items = indices.map(i => todos.value[i]!);
  respond({ action: "send", todos: items, note: note.value });
}

function cancel() {
  respond({ action: "cancel" });
}

function respond(payload: any) {
  fs.writeFileSync(responseFile, JSON.stringify(payload));
  (window as any).close();
}
</script>

<style scoped>
.app {
  display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  background: #1a1a2e; color: #e0e0e0;
}
.header { padding: 14px 20px 8px; border-bottom: 1px solid #2a2a4a; }
.header h1 { font-size: 15px; color: #4ec9b0; margin: 0; }
.header .sub { font-size: 12px; color: #888; margin-top: 3px; }

.section-label { padding: 8px 20px 4px; font-size: 11px; color: #4ec9b0; letter-spacing: 0.5px; }
.section-label.dim { color: #666; }

.list { flex: 1; overflow-y: auto; min-height: 0; }
.list.dim { flex: none; max-height: 200px; }

.todo-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 20px; cursor: pointer; user-select: none;
  border-bottom: 1px solid #1f1f3a; min-height: 32px;
}
.todo-row:hover { background: #232340; }
.todo-row.selected { background: #2a2a50; }
.todo-row.done-row { opacity: 0.5; cursor: default; }
.todo-row.done-row:hover { background: transparent; }

.checkbox { font-size: 14px; color: #4ec9b0; min-width: 18px; }
.checkbox.dim { color: #555; }
.idx { font-size: 12px; color: #e6b422; min-width: 24px; text-align: right; }
.loc { font-size: 12px; color: #888; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px; flex-shrink: 1; }
.text { font-size: 13px; color: #ccc; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.text.dim { color: #666; }
.loc.dim { color: #555; }

.btn-loc {
  background: none; border: 1px solid #333; color: #888;
  border-radius: 3px; cursor: pointer; padding: 2px 6px; font-size: 12px;
  flex-shrink: 0;
}
.btn-loc:hover { background: #333; color: #4ec9b0; border-color: #4ec9b0; }

.note-area { padding: 10px 20px; border-top: 1px solid #2a2a4a; }
.note-area textarea {
  width: 100%; padding: 8px 12px;
  background: #0d0d1a; border: 1px solid #333; border-radius: 4px;
  color: #e0e0e0; font-size: 13px; resize: vertical; font-family: inherit;
}
.note-area textarea:focus { outline: none; border-color: #4ec9b0; }
.note-area textarea::placeholder { color: #555; }

.actions {
  padding: 10px 20px; border-top: 1px solid #2a2a4a;
  display: flex; gap: 10px; justify-content: flex-end; align-items: center;
}
.count { font-size: 11px; color: #777; margin-right: auto; }
.btn {
  padding: 8px 20px; border: none; border-radius: 4px;
  font-size: 13px; cursor: pointer; font-family: inherit;
}
.btn-clear { background: #444; color: #ccc; }
.btn-clear:hover { background: #555; }
</style>
