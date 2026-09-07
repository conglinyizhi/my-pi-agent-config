<template>
  <div class="gate-fragment">
    <footer class="actions" title="Ctrl+Enter 允许本次请求；Esc 关闭拒绝理由">
      <template v-if="isSandboxAllow">
        <button data-name="sa-deny" @click="$emit('respond', { action: 'deny' })" class="btn btn-deny">🚫 拒绝</button>
        <button data-name="sa-deny-reason" @click="openDialog" class="btn btn-warn">📝 拒绝并说明理由</button>
        <button data-name="sa-allow" @click="$emit('respond', { action: 'allow' })" class="btn btn-allow">✅ 允许（仅此一次）</button>
      </template>
      <template v-else>
        <button data-name="action-deny" @click="$emit('respond', { action: 'deny' })" class="btn btn-deny">🚫 拒绝</button>
        <button data-name="action-deny-reason" @click="openDialog" class="btn btn-warn">📝 拒绝并说明理由</button>
        <button data-name="action-allow" @click="$emit('respond', { action: 'allow' })" class="btn btn-allow">{{ isCapability ? '✅ 允许本次命令' : '✅ 放行' }}</button>
      </template>
    </footer>

    <!-- 拒绝理由对话框（audit + sandbox-allow） -->
    <div v-if="dialog" @click.self="dialog = false" class="overlay">
      <div class="dialog">
        <h2 class="dialog-title">{{ isSandboxAllow ? '拒绝理由' : isCapability ? '拒绝理由' : '审核意见' }}</h2>
        <template v-if="!isSandboxAllow && !isCapability">
          <div v-for="(rule, index) in rules" :key="index" @click="toggleFlag(index)" class="dialog-rule" :class="{ flagged: flagged.has(index) }">
            <input data-name="rule-check" type="checkbox" :checked="flagged.has(index)" class="dialog-check">
            <code class="rule-pattern">{{ rule.name }}</code>
            <span v-if="rule.matched && rule.matched.length" class="rule-matched">{{ rule.matched.join(' ') }}</span>
            <span class="rule-tip">{{ rule.tip }}</span>
          </div>
          <div v-if="flagged.size > 0" class="flagged-hint">已标记 {{ flagged.size }} 个危险点</div>
        </template>
        <label class="dialog-label">理由：</label>
        <select data-name="reason-select" v-model="text" class="dialog-select">
          <option value="">-- 手动输入 --</option>
          <option v-for="reason in reasons" :key="reason.t" :value="reason.content">{{ reason.title }}</option>
        </select>
        <textarea data-name="reason-text" v-model="text" placeholder="拒绝理由..." rows="2" class="dialog-textarea"></textarea>
        <div class="dialog-footer">
          <button data-name="dialog-cancel" @click="dialog = false" class="btn btn-cancel">取消</button>
          <button data-name="dialog-confirm" @click="submit" class="btn btn-deny">确认拒绝</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from "vue";

const props = defineProps({
  isSandboxAllow: Boolean,
  isCapability: Boolean,
  rules: { type: Array, default: () => [] },
  reasons: { type: Array, default: () => [] },
});
const emit = defineEmits(["respond", "save-reason"]);
const dialog = ref(false);
const text = ref("");
const flagged = ref(new Set());

function openDialog() {
  flagged.value = new Set();
  dialog.value = true;
}
function toggleFlag(index) {
  const next = new Set(flagged.value);
  next.has(index) ? next.delete(index) : next.add(index);
  flagged.value = next;
}
function submit() {
  const comment = text.value.trim();
  if (comment) emit("save-reason", comment);
  emit("respond", { action: "deny", comment: comment || undefined, flagged: [...flagged.value] });
  dialog.value = false;
}

function onKeydown(event) {
  if (event.key === "Escape" && dialog.value) {
    event.preventDefault();
    dialog.value = false;
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (dialog.value) submit();
    else emit("respond", { action: "allow" });
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<style scoped>
.actions { padding: 10px 16px; border-top: 1px solid #2a2a4a; display: flex; gap: 10px; justify-content: flex-end; align-items: center; }
.dialog-title { font-size: 14px; color: #ff6b6b; margin: 0 0 8px; }
.dialog-rule { padding: 4px 6px; margin-bottom: 3px; border-radius: 3px; font-size: 11px; cursor: pointer; display: flex; gap: 6px; align-items: center; background: #16213e; border-left: 2px solid #ff6b6b; }
.dialog-rule.flagged { background: #2a1a0a; border-left-color: #e67e22; }
.dialog-check { accent-color: #e67e22; margin: 0; }
.flagged-hint { font-size: 11px; color: #e67e22; margin-bottom: 4px; }
.dialog-label { font-size: 11px; color: #888; display: block; margin: 6px 0 3px; }
.dialog-select { width: 100%; padding: 5px 8px; background: #0d0d1a; border: 1px solid #333; border-radius: 3px; color: #e0e0e0; font-size: 12px; -webkit-appearance: none; appearance: none; padding-right: 24px; background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; }
.dialog-textarea { width: 100%; padding: 5px 8px; background: #0d0d1a; border: 1px solid #333; border-radius: 3px; color: #e0e0e0; font-family: inherit; font-size: 12px; margin-top: 6px; resize: vertical; }
.dialog-footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
</style>

<style scoped>
.gate-fragment { display: contents; }
</style>
