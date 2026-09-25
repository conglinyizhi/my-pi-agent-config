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
    <div v-if="tip" class="tooltip" :class="tipTone" :style="tipPos">{{ tip }}</div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { mergeEnvHighlights, renderHighlightedCommand } from "../../domain/gate/highlights.js";
import { envNoteHighlights } from "../../domain/gate/env-notes.js";

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
  /** pi 侧算好的赋值解析结果：{name, raw, start, end, value?|reason?} */
  envNotes: { type: Array, default: () => [] },
  current: { type: Number, default: 0 },
});

const emit = defineEmits(["update:current"]);
const cmdBox = ref(null);
const tip = ref("");
/** tip 的底色：rule=黄（旧行为），env=绿（解析出来的值），env-unknown=灰（没解析出来） */
const tipTone = ref("rule");
const tipPos = ref({});
const commandHtml = computed(() =>
  renderHighlightedCommand(props.command, mergeEnvHighlights(envNoteHighlights(props.command, props.envNotes), props.highlights)),
);

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
  const isRule = target.tagName === "MARK" && target.classList.contains("h");
  // 赋值解析的标记用 mark.e（绿）/ mark.e-u（灰，解析不了），与规则标记分开：
  // 导航按 mark.h 数序号，混用会指错
  const isEnv = target.tagName === "MARK" && target.classList.contains("e");
  if (!isRule && !isEnv) return;
  tip.value = target.dataset.tip || "";
  tipTone.value = isRule ? "rule" : target.classList.contains("e-u") ? "env-unknown" : "env";
  const rect = target.getBoundingClientRect();
  tipPos.value = { left: `${rect.left}px`, top: `${rect.bottom + 4}px` };
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
.tooltip { position: fixed; background: #1a1a2e; border: 1px solid #e67e22; padding: 5px 10px; border-radius: 4px; font-size: 12px; color: #e67e22; z-index: 100; pointer-events: none; white-space: pre-line; max-width: 70vw; }
.tooltip.rule::before { content: "⚠️ "; }
.tooltip.env { border-color: #4ec9b0; color: #4ec9b0; }
.tooltip.env::before { content: "✓ "; }
.tooltip.env-unknown { border-color: #888; color: #b0b0b0; }
.tooltip.env-unknown::before { content: "? "; }
</style>

<style>
/* 动态生成的 mark 标签无法 scoped。 */
mark.h { background:#ff6b6b22; color:#e0e0e0; padding:1px 2px; border-radius:2px; cursor:pointer; transition:all 0.12s; }
mark.h:hover { background:#ff6b6b44; }
mark.h.f { background:#ff6b6b55; outline:1px solid #ff6b6b; color:#ff6b6b; }
/* 赋值解析：绿=解析出来了，灰=解析不了（悬停看值或原因） */
mark.e { background:#4ec9b022; color:#e0e0e0; padding:1px 2px; border-radius:2px; cursor:help; box-shadow: inset 0 0 0 1px #4ec9b055; transition:all 0.12s; }
mark.e:hover { background:#4ec9b044; }
mark.e-u { background:#88888822; cursor:help; box-shadow: inset 0 0 0 1px #88888855; }
mark.e-u:hover { background:#88888844; }
</style>

<style scoped>
.gate-fragment { display: contents; }
</style>
