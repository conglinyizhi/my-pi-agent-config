<template>
  <div v-if="initData" class="app">
    <header class="header">
      <h1>📋 TODO 调度</h1>
      <div class="sub">{{ todos.length }} 个待处理 / {{ done.length }} 已完成 · 点击方框选中，快速下达指令</div>
    </header>

    <!-- 待处理 -->
    <div class="section-label">待处理 ({{ todos.length }})</div>
    <div class="list">
      <div v-for="(item, i) in todos" :key="'p'+i"
        class="todo-row" :class="{ selected: selected.has(i) }"
        @click="openDetail(item)">
        <input type="checkbox" class="native-checkbox" data-name="todo-checkbox"
          :checked="selected.has(i)" @click.stop @change="toggle(i)" />
        <span class="idx">{{ i + 1 }}</span>
        <span class="loc">{{ item.file }}:{{ item.line }}</span>
        <span class="text">{{ item.text }}</span>
        <button class="btn-loc" data-name="todo-locate" @click.stop="locate(item)" title="用编辑器打开">↗</button>
      </div>
    </div>

    <!-- 已完成 -->
    <div v-if="done.length" class="section-label dim">已完成 ({{ done.length }})</div>
    <div v-if="done.length" class="list dim">
      <div v-for="item in done" :key="'d'+item.file+item.line" class="todo-row done-row"
        @click="openDetail(item)">
        <input type="checkbox" class="native-checkbox" disabled checked @click.stop />
        <span class="loc dim">{{ item.file }}:{{ item.line }}</span>
        <span class="text dim">{{ item.text }}</span>
        <button class="btn-loc" @click.stop="locate(item)">↗</button>
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
      <button data-name="todo-cancel" class="btn btn-cancel" @click="cancel">关闭</button>
      <button data-name="todo-clear" class="btn btn-clear" @click="selected.clear(); note=''">清空</button>
      <button data-name="todo-select-all" class="btn btn-clear" @click="selectAll">{{ allSelected ? '取消全选' : '全选' }}</button>
      <button data-name="todo-send" class="btn btn-allow" :disabled="selectedCount === 0" @click="send">
        {{ selectedCount > 0 ? `发送 (${selectedCount})` : '发送' }}
      </button>
    </footer>

    <!-- 详情弹窗 -->
    <div v-if="detailItem" class="overlay" @click.self="closeDetail">
      <div class="detail-dialog">
        <h2 class="detail-filename">来自 {{ basename(detailItem.file) }} 的代办</h2>
        <div class="detail-dir">位置：{{ absDir(detailItem.file) }}:{{ detailItem.line }}</div>
        <pre class="detail-body">{{ detailItem.text }}</pre>
        <footer class="actions">
          <button class="btn btn-cancel" @click="closeDetail">关闭</button>
          <button class="btn btn-allow" @click="locate(detailItem); closeDetail()">前往文件</button>
        </footer>
      </div>
    </div>
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

const detailItem = ref<TodoItem | null>(null);
function openDetail(item: TodoItem) { detailItem.value = item; }
function closeDetail() { detailItem.value = null; }
const path = (window as any).require("path");
const cwd: string = initData.cwd || ".";
function absDir(file: string) {
  const clean = file.replace(/^\.\//, "");
  const abs = path.resolve(cwd, clean);
  if (abs.length <= 56) return abs;
  return "…" + abs.slice(-55);
}
function basename(path: string) { const i = path.lastIndexOf('/'); return i >= 0 ? path.substring(i + 1) : path; }

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

.native-checkbox { accent-color: #4ec9b0; min-width: 16px; cursor: pointer; margin: 0; }
.native-checkbox:disabled { opacity: 0.4; cursor: default; }
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

/* page controls (base .btn / .actions / .count from gui-theme) */
.btn-clear { background: #444; color: #ccc; }
.btn-clear:hover { background: #555; }

/* 详情弹窗 */
.detail-dialog {
  background: #1a1a2e; border: 1px solid #3a3a5a; border-radius: 8px;
  max-width: 620px; width: 90%; max-height: 80vh; display: flex; flex-direction: column;
  padding: 24px; gap: 12px;
}
.detail-filename { font-size: 16px; color: #4ec9b0; margin: 0; word-break: break-all; }
.detail-dir { font-size: 13px; color: #888; font-style: italic; }
.detail-body {
  background: #0d0d1a; border: 1px solid #2a2a4a; border-radius: 6px;
  padding: 14px 16px; color: #ccc; font-size: 13px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word;
  overflow-y: auto; max-height: 45vh; margin: 0; font-family: inherit;
}
.detail-dialog .actions { border-top: none; padding: 0; }
</style>
