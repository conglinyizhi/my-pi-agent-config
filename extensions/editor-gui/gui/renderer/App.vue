<template>
  <div class="app" @keydown.escape="cancel">
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

<script setup lang="ts">
import "../../../../lib/gui-theme.css";
import { ref, nextTick } from "vue";

const initData = (window as any).__INIT_DATA__ || {};
const clipHistory: string[] = initData.clipHistory || [];
const responseFile: string = initData.responseFile || "";
const fs = (window as any).require("fs");

const presetTags = ["reflection", "think", "response", "analysis"];

const showHistory = ref(false);
const editorRef = ref<HTMLTextAreaElement | null>(null);
const editorText = ref("");
const customTag = ref("");
const quickInput = ref("");

function getTextarea(): HTMLTextAreaElement | null {
  return editorRef.value;
}

function insertAtCursor(text: string) {
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

function insertTag(tag: string) {
  if (!tag.trim()) return;
  const tagName = tag.trim().replace(/[<>]/g, "");
  const ta = getTextarea();
  if (ta && ta.selectionStart !== ta.selectionEnd) {
    // 包裹选中文本
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
    // 插入空标签，选中中间内容
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

function pickHistory(i: number) {
  editorText.value = (clipHistory as string[])[i] || "";
  showHistory.value = false;
}

function restoreToPi() {
  if (!editorText.value.trim()) return;
  fs.writeFileSync(responseFile, JSON.stringify({ action: "restore", text: editorText.value }));
  (window as any).close();
  showHistory.value = false;
}

function cancel() {
  fs.writeFileSync(responseFile, JSON.stringify({ cancelled: true }));
  (window as any).close();
}
</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-primary, #1a1a2e);
  color: var(--text-primary, #e0e0e0);
  font-family: "JetBrains Mono", "Fira Code", monospace;
}

/* header */
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-subtle, #2a2a4a);
  flex-shrink: 0;
}
.title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-accent, #4ec9b0);
}
.header-right {
  display: flex;
  gap: 8px;
  align-items: center;
}
.hist-toggle {
  background: var(--bg-secondary, #16213e);
  border: 1px solid var(--border-subtle, #2a2a4a);
  color: var(--text-secondary, #888);
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.hist-toggle:hover {
  background: var(--bg-hover, #1a3a5c);
  color: var(--text-primary, #e0e0e0);
}

/* tag bar */
.tag-bar {
  display: flex;
  gap: 6px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border-subtle, #2a2a4a);
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: center;
}
.tag-btn {
  background: var(--bg-tag, #1e2d3d);
  border: 1px solid var(--border-subtle, #2a2a4a);
  color: var(--text-accent, #4ec9b0);
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.tag-btn:hover {
  background: var(--bg-hover, #1a3a5c);
  border-color: var(--text-accent, #4ec9b0);
}
.tag-custom {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-left: 8px;
}
.tag-input {
  width: 100px;
  padding: 3px 8px;
  background: var(--bg-input, #0d0d1a);
  border: 1px solid var(--border-subtle, #2a2a4a);
  border-radius: 12px;
  color: var(--text-primary, #e0e0e0);
  font-size: 12px;
  font-family: inherit;
}
.tag-add {
  padding: 3px 8px;
  font-weight: bold;
}

/* editor */
.editor {
  flex: 1;
  padding: 12px 16px;
  border: none;
  outline: none;
  resize: none;
  background: var(--bg-editor, #0d0d1a);
  color: var(--text-primary, #e0e0e0);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.7;
}
.editor::placeholder {
  color: var(--text-muted, #555);
}

/* insert bar */
.insert-bar {
  display: flex;
  gap: 8px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-subtle, #2a2a4a);
  flex-shrink: 0;
  align-items: center;
}
.insert-input {
  flex: 1;
  padding: 8px 12px;
  background: var(--bg-input, #0d0d1a);
  border: 1px solid var(--border-subtle, #2a2a4a);
  border-radius: 4px;
  color: var(--text-primary, #e0e0e0);
  font-size: 13px;
  font-family: inherit;
}
.insert-input::placeholder {
  color: var(--text-muted, #555);
}

/* footer */
.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-subtle, #2a2a4a);
  flex-shrink: 0;
}

/* button variants (base .btn from gui-theme) */
.btn-primary {
  background: var(--accent, #3498db);
  color: #fff;
}
.btn-primary:hover {
  background: #2980b9;
}
.btn-insert {
  background: var(--bg-tag, #1e2d3d);
  color: var(--text-accent, #4ec9b0);
  border: 1px solid var(--border-subtle, #2a2a4a);
  white-space: nowrap;
}
.btn-insert:hover {
  background: var(--bg-hover, #1a3a5c);
  border-color: var(--text-accent, #4ec9b0);
}

/* history overlay */
.hist-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.3);
}
.hist-dropdown {
  position: absolute;
  top: 60px;
  right: 16px;
  width: 340px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg-primary, #1a1a2e);
  border: 1px solid var(--border-subtle, #2a2a4a);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.hist-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-subtle, #2a2a4a);
  font-size: 13px;
  color: var(--text-secondary, #888);
  position: sticky;
  top: 0;
  background: var(--bg-primary, #1a1a2e);
}
.hist-close {
  background: none;
  border: none;
  color: var(--text-secondary, #888);
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
}
.hist-item {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-subtle, #1f1f3a);
  cursor: pointer;
  font-size: 12px;
}
.hist-item:hover {
  background: var(--bg-hover, #16213e);
}
.hist-num {
  color: var(--text-muted, #555);
  flex-shrink: 0;
  font-size: 11px;
}
.hist-preview {
  color: var(--text-secondary, #ccc);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hist-empty {
  padding: 16px;
  color: var(--text-muted, #666);
  font-size: 13px;
  text-align: center;
}
</style>
