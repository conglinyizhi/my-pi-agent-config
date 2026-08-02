<template>
  <div v-if="ready" class="app" @keydown.escape="cancel">
    <!-- header -->
    <header class="header">
      <span class="title">提示词输入</span>
      <div class="header-right">
        <button class="hist-toggle" @click="showHistory = !showHistory">
          📋 历史<span v-if="clipHistory.length">({{ clipHistory.length }})</span>
        </button>
      </div>
    </header>

    <!-- XML 标签栏 -->
    <div class="tag-bar">
      <button
        v-for="tag in presetTags"
        :key="tag"
        class="tag-btn"
        @click="insertTag(tag)"
      >&lt;{{ tag }}&gt;</button>
      <span class="tag-custom">
        <input
          v-model="customTag"
          placeholder="自定义标签"
          class="tag-input"
          @keyup.enter="insertTag(customTag)"
        >
        <button class="tag-btn tag-add" @click="insertTag(customTag)">+</button>
      </span>
    </div>

    <!-- 主编辑器 -->
    <textarea
      ref="editorRef"
      v-model="editorText"
      spellcheck="false"
      class="editor"
      placeholder="在此编辑内容，或从下方输入快速插入…"
    ></textarea>

    <!-- 底部插入栏 -->
    <div class="insert-bar">
      <input
        v-model="quickInput"
        placeholder="输入要插入的内容…"
        class="insert-input"
        @keyup.enter="insertQuick"
      >
      <button class="btn btn-insert" @click="insertQuick">→ 插入到编辑器</button>
    </div>

    <!-- 底部操作 -->
    <footer class="footer">
      <button class="btn btn-primary" @click="restoreToPi">↩ 恢复到输入框</button>
      <button class="btn btn-cancel" @click="cancel">取消</button>
    </footer>

    <!-- 历史浮层 -->
    <Teleport to="body">
      <div v-if="showHistory" class="hist-overlay" @click.self="showHistory = false">
        <div class="hist-dropdown">
          <div class="hist-header">
            <span>剪贴板历史</span>
            <button class="hist-close" @click="showHistory = false">✕</button>
          </div>
          <div class="hist-list">
            <div
              v-for="(item, i) in clipHistory"
              :key="i"
              class="hist-item"
              @click="pickHistory(i)"
            >
              <span class="hist-num">#{{ i + 1 }}</span>
              <span class="hist-preview">{{ item.slice(0, 60).replace(/\n/g, ' ') }}</span>
            </div>
            <div v-if="clipHistory.length === 0" class="hist-empty">暂无历史</div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import "../gui-theme.css";
import { ref, nextTick, onMounted } from "vue";

const ready = ref(false);
const clipHistory = ref([]);

const presetTags = ["reflection", "think", "response", "analysis"];

const showHistory = ref(false);
const editorRef = ref(null);
const editorText = ref("");
const customTag = ref("");
const quickInput = ref("");

function getTextarea() {
  return editorRef.value;
}

function insertAtCursor(text) {
  const ta = getTextarea();
  if (!ta) {
    editorText.value += text;
    return;
  }
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const before = editorText.value.slice(0, start);
  const after = editorText.value.slice(end);
  editorText.value = before + text + after;
  nextTick(() => {
    ta.focus();
    const pos = start + text.length;
    ta.setSelectionRange(pos, pos);
  });
}

function insertTag(tag) {
  if (!tag.trim()) return;
  const tagName = tag.trim().replace(/[<>]/g, "");
  const ta = getTextarea();
  if (ta && ta.selectionStart !== ta.selectionEnd) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = editorText.value.slice(start, end);
    const wrapped = `<${tagName}>${selected}</${tagName}>`;
    editorText.value =
      editorText.value.slice(0, start) + wrapped + editorText.value.slice(end);
    nextTick(() => {
      ta.focus();
      ta.setSelectionRange(start + wrapped.length, start + wrapped.length);
    });
  } else {
    const inner = `\n\n`;
    const text = `<${tagName}>${inner}</${tagName}>`;
    insertAtCursor(text);
    if (ta) {
      const pos = ta.selectionStart;
      const innerStart = pos - text.length + tagName.length + 2;
      ta.setSelectionRange(innerStart, innerStart + 2);
    }
  }
  customTag.value = "";
}

function insertQuick() {
  if (!quickInput.value.trim()) return;
  insertAtCursor(quickInput.value);
  quickInput.value = "";
}

function pickHistory(i) {
  editorText.value = clipHistory.value[i] || "";
  showHistory.value = false;
}

async function respond(payload) {
  await window.go.main.App.SaveResponse(JSON.stringify(payload));
  window.runtime.Quit();
}

function restoreToPi() {
  if (!editorText.value.trim()) return;
  respond({ action: "restore", text: editorText.value });
}

function cancel() {
  respond({ cancelled: true });
}

onMounted(async () => {
  const data = await window.go.main.App.GetInitData();
  clipHistory.value = data.clipHistory || [];
  ready.value = true;
  await window.go.main.App.MarkReady();
  nextTick(() => editorRef.value?.focus());
});
</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: #1a1a2e;
  color: #e0e0e0;
  font-family: "JetBrains Mono", "Fira Code", monospace;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid #2a2a4a;
  flex-shrink: 0;
}
.title { font-size: 14px; font-weight: 600; color: #4ec9b0; }
.header-right { display: flex; gap: 8px; align-items: center; }
.hist-toggle {
  background: #16213e; border: 1px solid #2a2a4a; color: #888;
  padding: 4px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.hist-toggle:hover { background: #1a3a5c; color: #e0e0e0; }

.tag-bar {
  display: flex; gap: 6px; padding: 6px 16px;
  border-bottom: 1px solid #2a2a4a; flex-shrink: 0; flex-wrap: wrap; align-items: center;
}
.tag-btn {
  background: #1e2d3d; border: 1px solid #2a2a4a; color: #4ec9b0;
  padding: 3px 10px; border-radius: 12px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.tag-btn:hover { background: #1a3a5c; border-color: #4ec9b0; }
.tag-custom { display: flex; gap: 4px; align-items: center; margin-left: 8px; }
.tag-input {
  width: 100px; padding: 3px 8px; background: #0d0d1a;
  border: 1px solid #2a2a4a; border-radius: 12px; color: #e0e0e0; font-size: 12px; font-family: inherit;
}
.tag-add { padding: 3px 8px; font-weight: bold; }

.editor {
  flex: 1; padding: 12px 16px; border: none; outline: none; resize: none;
  background: #0d0d1a; color: #e0e0e0; font-family: inherit;
  font-size: 14px; line-height: 1.7;
}
.editor::placeholder { color: #555; }

.insert-bar {
  display: flex; gap: 8px; padding: 8px 16px;
  border-top: 1px solid #2a2a4a; flex-shrink: 0; align-items: center;
}
.insert-input {
  flex: 1; padding: 8px 12px; background: #0d0d1a;
  border: 1px solid #2a2a4a; border-radius: 4px; color: #e0e0e0; font-size: 13px; font-family: inherit;
}
.insert-input::placeholder { color: #555; }

.footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 8px 16px; border-top: 1px solid #2a2a4a; flex-shrink: 0;
}

.btn-primary { background: #3498db; color: #fff; }
.btn-primary:hover { background: #2980b9; }
.btn-insert {
  background: #1e2d3d; color: #4ec9b0; border: 1px solid #2a2a4a; white-space: nowrap;
}
.btn-insert:hover { background: #1a3a5c; border-color: #4ec9b0; }

.hist-overlay { position: fixed; inset: 0; z-index: 9999; background: rgba(0, 0, 0, 0.3); }
.hist-dropdown {
  position: absolute; top: 60px; right: 16px; width: 340px; max-height: 320px; overflow-y: auto;
  background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.hist-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 14px; border-bottom: 1px solid #2a2a4a;
  font-size: 13px; color: #888; position: sticky; top: 0; background: #1a1a2e;
}
.hist-close { background: none; border: none; color: #888; cursor: pointer; font-size: 16px; padding: 0 4px; }
.hist-item {
  display: flex; gap: 8px; align-items: baseline;
  padding: 8px 14px; border-bottom: 1px solid #1f1f3a; cursor: pointer; font-size: 12px;
}
.hist-item:hover { background: #16213e; }
.hist-num { color: #555; flex-shrink: 0; font-size: 11px; }
.hist-preview { color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-empty { padding: 16px; color: #666; font-size: 13px; text-align: center; }
</style>
