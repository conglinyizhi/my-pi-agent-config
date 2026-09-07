<template>
  <div class="gate-fragment">
    <header class="top-bar">
      <div class="top-left">
        <h1 :class="{ 'h1-sa': isSandboxAllow || isCapability }">{{ title }}</h1>
        <span v-if="taskId && !isSandboxAllow" class="task-badge">📋 {{ taskId }}</span>
        <span v-if="isSandboxAllow" data-name="sa-perm" class="perm-badge" :class="permission">{{ permLabel }}</span>
        <span v-if="isCapability" data-name="capability" class="perm-badge write-paths">{{ capability }}</span>
      </div>
      <div v-if="!isSandboxAllow && highlights.length > 0" class="hl-nav">
        <span class="hl-count">{{ current + 1 }} / {{ highlights.length }}</span>
        <button data-name="highlight-prev" @click="prev" :disabled="current <= 0" class="hl-btn">◀ 上一个</button>
        <button data-name="highlight-next" @click="next" :disabled="current >= highlights.length - 1" class="hl-btn">下一个 ▶</button>
      </div>
    </header>

    <pre ref="cmdBox" class="cmd-area" v-html="commandHtml" @mouseover="onHover" @mouseout="onLeave"></pre>
    <div v-if="tip" class="tooltip" :style="tipPos">⚠️ {{ tip }}</div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { renderHighlightedCommand } from "../../domain/gate/highlights.js";

const props = defineProps({
  title: { type: String, required: true },
  taskId: { type: [String, Number], default: null },
  isSandboxAllow: Boolean,
  isCapability: Boolean,
  permission: { type: String, default: "" },
  permLabel: { type: String, default: "" },
  capability: { type: String, default: "" },
  command: { type: String, default: "" },
  highlights: { type: Array, default: () => [] },
  current: { type: Number, default: 0 },
});

const emit = defineEmits(["update:current"]);
const cmdBox = ref(null);
const tip = ref("");
const tipPos = ref({});
const commandHtml = computed(() => renderHighlightedCommand(props.command, props.highlights));

function scroll() {
  nextTick(() => {
    const marks = cmdBox.value?.querySelectorAll("mark.h") ?? [];
    marks.forEach((mark, index) => mark.classList.toggle("f", index === props.current));
    marks[props.current]?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
function next() {
  if (props.current < props.highlights.length - 1) emit("update:current", props.current + 1);
}
function prev() {
  if (props.current > 0) emit("update:current", props.current - 1);
}
function onHover(event) {
  const target = event.target;
  if (target.tagName === "MARK" && target.classList.contains("h")) {
    tip.value = target.dataset.tip || "";
    const rect = target.getBoundingClientRect();
    tipPos.value = { left: `${rect.left}px`, top: `${rect.bottom + 4}px` };
  }
}
function onLeave() {
  tip.value = "";
}

onMounted(scroll);
watch(() => props.current, scroll);
watch(() => [props.command, props.highlights], scroll, { deep: true });
</script>

<style scoped>
.top-bar { padding: 8px 16px; border-bottom: 1px solid #2a2a4a; display: flex; justify-content: space-between; align-items: center; }
.top-left { display: flex; align-items: center; gap: 10px; }
.top-left h1 { font-size: 15px; color: #ff6b6b; margin: 0; }
.top-left h1.h1-sa { color: #7aa2f7; }
.task-badge { font-size: 11px; color: #7aa2f7; background: #1a1a3e; padding: 2px 8px; border-radius: 4px; }
.perm-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; }
.perm-badge.full-access { color: #ff6b6b; background: #3a1a1a; border: 1px solid #ff6b6b55; }
.perm-badge.write-paths { color: #7aa2f7; background: #1a1a3e; border: 1px solid #7aa2f755; }
.hl-nav { display: flex; gap: 6px; align-items: center; font-size: 12px; }
.hl-count { color: #888; }
.hl-btn { padding: 3px 10px; background: #2a2a4a; border: 1px solid #444; border-radius: 3px; color: #ccc; cursor: pointer; font-size: 11px; }
.hl-btn:disabled { opacity: 0.4; }
.cmd-area { flex: 1; margin: 0; padding: 16px; background: #0d0d1a; font-family: monospace; font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-all; overflow-wrap: break-word; overflow: auto; color: #e0e0e0; outline: none; }
.tooltip { position: fixed; background: #1a1a2e; border: 1px solid #e67e22; padding: 5px 10px; border-radius: 4px; font-size: 12px; color: #e67e22; z-index: 100; pointer-events: none; }
</style>

<style>
/* 动态生成的 mark 标签无法 scoped。 */
mark.h { background:#ff6b6b22; color:#e0e0e0; padding:1px 2px; border-radius:2px; cursor:pointer; transition:all 0.12s; }
mark.h:hover { background:#ff6b6b44; }
mark.h.f { background:#ff6b6b55; outline:1px solid #ff6b6b; color:#ff6b6b; }
</style>

<style scoped>
.gate-fragment { display: contents; }
</style>
