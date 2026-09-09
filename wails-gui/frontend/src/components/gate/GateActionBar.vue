<template>
  <div class="gate-fragment">
    <footer class="actions" title="Ctrl+Enter 允许本次请求；Esc 清空附言">
      <div class="comment-field" :class="{ 'has-text': comment.length > 0 }">
        <input
          ref="commentInput"
          v-model="comment"
          data-name="gate-comment-input"
          type="text"
          placeholder="附言（可选，随决定提交）"
          title="有内容时随拒绝/允许一起提交；空则不带"
        >
        <button v-if="comment.length > 0" data-name="gate-comment-clear" class="clear-input" title="清空附言（Esc）" @click="clearComment">✕</button>
      </div>
      <button data-name="gate-history-toggle" class="ghost" title="历史附言" @click.stop="toggleHistory">▾ 历史</button>
      <span class="chip-mark" :class="{ show: comment.trim().length > 0 }">将附带附言</span>
      <span class="spacer"></span>
      <button v-if="isSandboxAllow" data-name="sa-deny" class="btn btn-deny" @click="respond('deny')">🚫 拒绝</button>
      <button v-else data-name="action-deny" class="btn btn-deny" @click="respond('deny')">🚫 拒绝</button>
      <button v-if="isSandboxAllow" data-name="sa-allow" class="btn btn-allow" @click="respond('allow')">{{ allowLabel }}</button>
      <button v-else data-name="action-allow" class="btn btn-allow" @click="respond('allow')">{{ allowLabel }}</button>

      <div v-if="historyOpen" class="panel" @click.stop>
        <div class="panel-head"><span>历史附言</span><span class="count">{{ reasons.length }} 条</span></div>
        <div class="chips">
          <div v-if="reasons.length === 0" class="panel-empty">还没有历史附言</div>
          <template v-for="reason in reasons" :key="reason.content">
            <span class="chip-item" :class="{ editing: editingContent === reason.content }" :title="editingContent === reason.content ? undefined : reason.content">
            <template v-if="editingContent === reason.content">
              <input :ref="(el) => setEditInput(el, reason.content)" v-model="editingText" data-name="gate-history-edit" @keydown.enter.prevent="saveEdit(reason.content)">
              <button class="chip-icon" data-name="gate-history-edit" title="保存" @click="saveEdit(reason.content)">✓</button>
              <button class="chip-icon" data-name="gate-history-edit" title="取消" @click="cancelEdit">✕</button>
            </template>
            <template v-else>
              <span class="chip-text" data-name="gate-history-chip" @click="fillComment(reason.content)">{{ reason.content }}</span>
              <button class="chip-icon" data-name="gate-history-edit" title="编辑" @click="startEdit(reason.content)">✎</button>
              <button class="chip-icon del" data-name="gate-history-delete" title="删除这条" @click="deleteReason(reason.content)">✕</button>
            </template>
            </span>
          </template>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";

const props = defineProps({
  isSandboxAllow: Boolean,
  isCapability: Boolean,
  reasons: { type: Array, default: () => [] },
  comment: { type: String, default: "" },
});
const emit = defineEmits(["respond", "save-reason", "update-reason", "delete-reason", "update:comment"]);
// 附言状态提升到 GateView：sandbox-allow 的目录授权动作也要能带上附言
const comment = computed({
  get: () => props.comment,
  set: (value) => emit("update:comment", value),
});
const historyOpen = ref(false);
const editingContent = ref(null);
const editingText = ref("");
const commentInput = ref(null);
const editInputs = new Map();
const allowLabel = computed(() => props.isSandboxAllow ? "✅ 允许（仅此一次）" : props.isCapability ? "✅ 允许本次命令" : "✅ 允许");

function clearComment() {
  comment.value = "";
  commentInput.value?.focus();
}
function toggleHistory() {
  historyOpen.value = !historyOpen.value;
  if (!historyOpen.value) cancelEdit();
}
function fillComment(content) {
  comment.value = content;
  historyOpen.value = false;
  cancelEdit();
  nextTick(() => commentInput.value?.focus());
}
function startEdit(content) {
  editingContent.value = content;
  editingText.value = content;
  nextTick(() => editInputs.get(content)?.focus());
}
function setEditInput(el, content) {
  if (el) editInputs.set(content, el);
}
function cancelEdit() {
  editingContent.value = null;
  editingText.value = "";
}
function saveEdit(oldContent) {
  const content = editingText.value.trim();
  if (!content) return;
  emit("update-reason", { oldContent, newContent: content });
  cancelEdit();
}
function deleteReason(content) {
  emit("delete-reason", content);
  if (editingContent.value === content) cancelEdit();
}
function respond(action) {
  const text = comment.value.trim();
  if (text) emit("save-reason", text);
  emit("respond", text ? { action, comment: text } : { action });
}
function onKeydown(event) {
  if (event.key === "Escape") {
    if (historyOpen.value) {
      historyOpen.value = false;
    } else if (editingContent.value !== null) {
      cancelEdit();
    } else {
      clearComment();
    }
    event.preventDefault();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    respond("allow");
  }
}
function onDocumentClick() {
  historyOpen.value = false;
  cancelEdit();
}
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  document.addEventListener("click", onDocumentClick);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  document.removeEventListener("click", onDocumentClick);
});
</script>

<style scoped>
.actions { position: relative; padding: 10px 16px; border-top: 1px solid #2a2a4a; background: #14142a; display: flex; gap: 8px; align-items: center; }
.comment-field { position: relative; flex: 1; min-width: 120px; display: flex; }
.comment-field input { width: 100%; padding: 7px 30px 7px 10px; font-size: 12.5px; font-family: inherit; color: #e0e0e0; background: #0d0d1a; border: 1px solid #2a2a4a; border-radius: 4px; outline: none; }
.comment-field input:focus { border-color: #4ec9b0; }
.clear-input { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; line-height: 16px; text-align: center; border: none; border-radius: 50%; background: #33334d; color: #888; font-size: 11px; cursor: pointer; }
.clear-input:hover { background: #e74c3c; color: #fff; }
.ghost { padding: 7px 12px; font-size: 12px; border-radius: 4px; cursor: pointer; background: transparent; color: #888; border: 1px solid #2a2a4a; font-family: inherit; }
.ghost:hover { color: #e0e0e0; border-color: #444; }
.chip-mark { font-size: 11px; color: #2ecc71; background: #12261a; border: 1px solid #2ecc7155; padding: 2px 8px; border-radius: 10px; white-space: nowrap; opacity: 0; }
.chip-mark.show { opacity: 1; }
.spacer { flex: 1; }
.btn { padding: 8px 20px; border: none; border-radius: 4px; font-size: 13px; cursor: pointer; font-family: inherit; }
.btn:hover { filter: brightness(1.1); }
.btn-deny { background: #e74c3c; color: #fff; }
.btn-allow { background: #2ecc71; color: #fff; }
.panel { position: absolute; left: 16px; bottom: calc(100% + 6px); width: 460px; max-height: 280px; overflow: auto; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 6px; box-shadow: 0 10px 30px rgba(0,0,0,.6); z-index: 20; }
.panel-head { padding: 8px 12px; font-size: 11px; color: #888; border-bottom: 1px solid #2a2a4a; display: flex; align-items: center; gap: 8px; position: sticky; top: 0; background: #1a1a2e; }
.count { margin-left: auto; color: #666; }
.chips { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 6px; padding: 10px 12px; }
.chip-item { display: inline-flex; align-items: center; gap: 2px; min-width: 0; padding: 3px 4px 3px 10px; border-radius: 14px; background: #1e1e38; border: 1px solid #33334d; font-size: 12px; line-height: 1.5; }
.chip-item:hover { border-color: #4ec9b0; background: #16213e; }
.chip-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e0e0e0; cursor: pointer; }
.chip-text:hover { color: #4ec9b0; }
.chip-icon { flex-shrink: 0; width: 18px; height: 18px; line-height: 16px; text-align: center; border: none; border-radius: 50%; background: transparent; color: #888; font-size: 11px; cursor: pointer; opacity: 0; }
.chip-item:hover .chip-icon, .chip-item.editing .chip-icon { opacity: 1; }
.chip-icon:hover { background: #33334d; color: #e0e0e0; }
.chip-icon.del:hover { background: #e74c3c; color: #fff; }
.chip-item.editing { padding: 2px 4px 2px 8px; border-color: #4ec9b0; background: #0d0d1a; }
.chip-item.editing input { flex: 1; min-width: 0; padding: 3px 6px; font-size: 12px; font-family: inherit; color: #e0e0e0; background: #1a1a2e; border: 1px solid #4ec9b0; border-radius: 3px; outline: none; }
.panel-empty { padding: 16px 12px; font-size: 12px; color: #666; text-align: center; grid-column: 1 / -1; }
</style>

<style scoped>
.gate-fragment { display: contents; }
</style>
