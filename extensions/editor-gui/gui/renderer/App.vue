<template>
  <div class="app">
    <aside class="sidebar">
      <div class="tabs">
        <button :class="{ active: tab === 'history' }" @click="tab = 'history'">📋 历史</button>
        <button :class="{ active: tab === 'file' }" @click="tab = 'file'">📁 文件</button>
      </div>
      <div class="list" v-if="tab === 'history'">
        <div
          v-for="(item, i) in clipHistory"
          :key="i"
          class="list-item"
          :class="{ selected: selectedIndex === i }"
          @click="selectHistory(i)"
        >
          <div class="preview">{{ item.slice(0, 120).replace(/\n/g, '↵ ') }}</div>
          <div class="meta">#{{ i + 1 }} {{ item.length }} 字符</div>
        </div>
        <div v-if="clipHistory.length === 0" class="empty">暂无 Ctrl+C 历史</div>
      </div>
      <div class="list" v-else>
        <div class="file-open">
          <input v-model="filePath" placeholder="输入文件路径..." @keyup.enter="openFile">
          <button class="btn btn-small" @click="openFile">打开</button>
        </div>
      </div>
    </aside>
    <main class="main">
      <header class="header">
        <span class="header-text">{{ headerText }}</span>
      </header>
      <textarea v-model="editorText" spellcheck="false" class="editor"></textarea>
      <footer class="footer">
        <span class="file-info">{{ fileInfo }}</span>
        <button class="btn btn-restore" @click="restoreToPi">↩ 恢复到 pi</button>
        <button class="btn btn-save" @click="saveFile">💾 保存</button>
        <button class="btn btn-cancel" @click="cancel">取消</button>
      </footer>
    </main>
  </div>
</template>

<script setup lang="ts">
import "../../../../lib/gui-theme.css";
import { ref, computed, onMounted } from "vue";

// ── 初始化数据 ──
const initData = (window as any).__INIT_DATA__ || {};
const clipHistory: string[] = initData.clipHistory || [];
const responseFile: string = initData.responseFile || "";
const openFileArg: string = initData.file || "";

const fs = (window as any).require("fs");

// ── 状态 ──
const tab = ref<"history" | "file">("history");
const selectedIndex = ref<number>(-1);
const editorText = ref("");
const currentFile = ref<string | null>(null);
const filePath = ref(openFileArg);
const fileInfo = ref("");

const headerText = computed(() => {
  if (currentFile.value) return currentFile.value;
  if (selectedIndex.value >= 0) return `Ctrl+C 历史 #${selectedIndex.value + 1}`;
  return "选择一条历史或打开一个文件";
});

// ── 方法 ──
function selectHistory(i: number) {
  selectedIndex.value = i;
  currentFile.value = null;
  editorText.value = clipHistory[i] || "";
  fileInfo.value = "";
}

function openFile() {
  const p = filePath.value.trim();
  if (!p) return;
  try {
    const content = fs.readFileSync(p, "utf-8");
    editorText.value = content;
    currentFile.value = p;
    selectedIndex.value = -1;
    fileInfo.value = `已加载 ${content.length} 字符`;
  } catch (e: any) {
    fileInfo.value = `错误: ${e.message}`;
  }
}

function saveFile() {
  if (!currentFile.value) {
    fileInfo.value = "请先打开一个文件";
    return;
  }
  try {
    fs.writeFileSync(currentFile.value, editorText.value, "utf-8");
    fileInfo.value = "已保存";
  } catch (e: any) {
    fileInfo.value = `保存失败: ${e.message}`;
  }
}

function restoreToPi() {
  if (!editorText.value.trim()) return;
  respond({ action: "restore", text: editorText.value });
}

function cancel() {
  respond({ cancelled: true });
}

function respond(payload: any) {
  fs.writeFileSync(responseFile, JSON.stringify(payload));
  (window as any).close();
}

// ── 快捷键 ──
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    saveFile();
  }
  if (e.key === "Escape") cancel();
});

// ── 初始 ──
onMounted(() => {
  if (openFileArg) openFile();
  else if (clipHistory.length > 0) selectHistory(0);
});
</script>

<style scoped>
.app {
  display: flex; height: 100vh; overflow: hidden;
  background: #1a1a2e; color: #e0e0e0;
}

/* 侧栏 */
.sidebar {
  width: 280px; border-right: 1px solid #2a2a4a;
  display: flex; flex-direction: column;
}

.tabs {
  display: flex; border-bottom: 1px solid #2a2a4a;
}
.tabs button {
  flex: 1; padding: 10px; background: transparent;
  border: none; color: #888; font-size: 13px; cursor: pointer;
  font-family: inherit;
}
.tabs button.active { color: #4ec9b0; border-bottom: 2px solid #4ec9b0; }

.list { flex: 1; overflow-y: auto; }
.list-item {
  padding: 10px 12px; border-bottom: 1px solid #1f1f3a;
  cursor: pointer;
}
.list-item:hover { background: #16213e; }
.list-item.selected { background: #1a3a5c; border-left: 3px solid #4ec9b0; }
.preview {
  font-size: 12px; color: #ccc; line-height: 1.5;
  white-space: pre-wrap; word-break: break-all;
  max-height: 3.6em; overflow: hidden;
}
.meta { font-size: 10px; color: #666; margin-top: 4px; }
.empty { padding: 16px; color: #666; font-size: 13px; }
.file-open {
  padding: 16px; display: flex; flex-direction: column; gap: 8px;
}
.file-open input {
  width: 100%; padding: 8px;
  background: #0d0d1a; border: 1px solid #333; border-radius: 4px;
  color: #e0e0e0; font-size: 13px; font-family: inherit;
}

/* 主面板 */
.main { flex: 1; display: flex; flex-direction: column; }
.header {
  padding: 8px 16px; border-bottom: 1px solid #2a2a4a;
  font-size: 12px; color: #888;
}
.editor {
  flex: 1; padding: 16px; border: none; outline: none; resize: none;
  background: #0d0d1a; color: #e0e0e0;
  font-family: "JetBrains Mono", monospace;
  font-size: 14px; line-height: 1.7;
}
.footer {
  padding: 8px 16px; border-top: 1px solid #2a2a4a;
  display: flex; gap: 8px; justify-content: flex-end; align-items: center;
}
.file-info {
  font-size: 11px; color: #666; margin-right: auto;
}
.btn {
  padding: 8px 20px; border: none; border-radius: 4px;
  font-size: 13px; cursor: pointer; font-family: inherit;
}
.btn-small { padding: 6px 14px; font-size: 12px; }
.btn-restore { background: #3498db; color: #fff; }
.btn-restore:hover { background: #2980b9; }
.btn-save { background: #2ecc71; color: #fff; }
.btn-save:hover { background: #27ae60; }
.btn-cancel { background: #555; color: #ccc; }
.btn-cancel:hover { background: #666; }
</style>
