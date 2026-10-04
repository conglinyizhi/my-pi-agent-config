<template>
  <!-- 全屏拟态对话框：留 margin 露出黑色遮罩。点遮罩**不**关闭，只有关闭按钮与 Esc 收工 -->
  <div class="dlg-backdrop">
    <section class="dlg" data-name="call-detail" role="dialog" aria-modal="true">
      <header class="dlg-head">
        <div class="dlg-title">
          <span class="dlg-tool">{{ chip.label }}</span>
          <span class="dlg-kind" :class="`kind-${chip.tone}`">{{ chip.tone === "shell" ? "可执行 shell" : "文件编辑" }}</span>
          <span v-if="!chip.literal" class="dlg-vague">参数不是字面量</span>
        </div>
        <button data-name="call-detail-close" class="dlg-close" @click="$emit('close')">关闭 ✕</button>
      </header>

      <div class="dlg-meta">
        <span>{{ lineLabel }}</span>
        <span v-if="sizeLabel">{{ sizeLabel }}</span>
        <span v-if="body.kind === 'source'">这一处看不到内容，原文照摆</span>
      </div>

      <div class="dlg-body">
        <template v-if="body.kind === 'diff'">
          <div class="blk">
            <div class="blk-head blk-old">原内容</div>
            <pre class="blk-body" v-html="escaped(body.old)"></pre>
          </div>
          <div class="blk">
            <div class="blk-head blk-new">改成</div>
            <pre class="blk-body" v-html="escaped(body.new)"></pre>
          </div>
        </template>
        <div v-else-if="body.kind === 'content'" class="blk">
          <div class="blk-head">将写入的内容</div>
          <pre class="blk-body" v-html="escaped(body.text)"></pre>
        </div>
        <div v-else class="blk">
          <div class="blk-head">{{ chip.tone === "shell" ? "命令" : "调用" }}</div>
          <pre class="blk-body" v-html="bodyHtml" @mouseover="onHover" @mouseout="tip = ''"></pre>
        </div>
        <div v-if="body.truncated" class="dlg-note">内容过长，这里只摆了前一段（规模按全文算）</div>
      </div>

      <footer class="dlg-foot">
        <span class="dlg-hint">点遮罩不关闭；Esc 或关闭按钮收工</span>
      </footer>
      <div v-if="tip" class="tooltip" :style="tipPos">{{ tip }}</div>
    </section>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { clipMarks } from "../../domain/gate/script-fold.js";
import { renderHighlightedCommand } from "../../domain/gate/highlights.js";

const props = defineProps({
  /** 折叠模型里的一颗芯片（含 pi 侧给的事实） */
  chip: { type: Object, required: true },
  /** 展示用脚本文本：非字面量时按区间切原文 */
  source: { type: String, default: "" },
  /** 合并后的标记（全局坐标），用来看被折住的危险片段 */
  marks: { type: Array, default: () => [] },
});
const emit = defineEmits(["close"]);

const tip = ref("");
const tipPos = ref({});

const body = computed(() => {
  const call = props.chip?.call ?? {};
  if (call.replacement) {
    return { kind: "diff", old: call.replacement.old, new: call.replacement.new, truncated: call.replacement.truncated };
  }
  if (typeof call.contentPreview === "string") {
    return { kind: "content", text: call.contentPreview, truncated: call.truncated === true };
  }
  return { kind: "source", text: (props.source ?? "").slice(call.startOffset, call.endOffset) };
});

const bodyHtml = computed(() =>
  body.value.kind === "source"
    ? renderHighlightedCommand(body.value.text, clipMarks(props.marks, props.chip.call.startOffset, props.chip.call.endOffset))
    : "",
);

const lineLabel = computed(() => {
  const call = props.chip?.call ?? {};
  if (typeof call.line !== "number") return "";
  return call.endLine && call.endLine !== call.line ? `第 ${call.line}..${call.endLine} 行` : `第 ${call.line} 行`;
});

const sizeLabel = computed(() => {
  const call = props.chip?.call ?? {};
  if (typeof call.bytes !== "number") return "";
  const size = call.bytes < 1024 ? `${call.bytes} 字节` : `${(call.bytes / 1024).toFixed(1)} KB`;
  return typeof call.lines === "number" ? `${size} · ${call.lines} 行` : size;
});

/** 预览正文只做转义：着色留给后面那一步统一接 */
function escaped(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function onHover(event) {
  const target = event.target;
  if (target.tagName !== "MARK") return;
  tip.value = target.dataset.tip || "";
  const rect = target.getBoundingClientRect();
  tipPos.value = { left: `${rect.left}px`, top: `${rect.bottom + 4}px` };
}

function onKeydown(event) {
  if (event.key === "Escape") emit("close");
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<style scoped>
.dlg-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.62); display: flex; z-index: 50; }
.dlg { flex: 1; margin: 26px; display: flex; flex-direction: column; min-height: 0; background: #10101f; border: 1px solid #2a2a4a; border-radius: 8px; box-shadow: 0 18px 60px #000a; overflow: hidden; }
.dlg-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #2a2a4a; background: #14142a; }
.dlg-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dlg-tool { font-family: monospace; font-size: 14px; color: #c0caf5; }
.dlg-kind { font-size: 11px; padding: 2px 8px; border-radius: 99px; border: 1px solid #444; }
.dlg-kind.kind-file { color: #b0b7c8; border-color: #555a6b; }
.dlg-kind.kind-shell { color: #e6a23c; border-color: #e6a23c66; background: #3a2a1233; }
.dlg-vague { font-size: 11px; color: #e6a23c; }
.dlg-close { padding: 4px 12px; font-size: 12px; color: #ccd; background: #1f1f38; border: 1px solid #2a2a4a; border-radius: 4px; cursor: pointer; }
.dlg-close:hover { color: #fff; border-color: #4ec9b055; }
.dlg-meta { display: flex; gap: 14px; padding: 6px 16px; font-size: 11px; color: #888; border-bottom: 1px solid #1f1f38; }
.dlg-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.blk { display: flex; flex-direction: column; min-height: 0; }
.blk-head { font-size: 11px; color: #9aa4bf; padding: 2px 0 4px; }
.blk-head.blk-old { color: #ff8080; }
.blk-head.blk-new { color: #6ee7a8; }
.blk-body { margin: 0; padding: 10px 12px; background: #0d0d1a; border: 1px solid #1f1f38; border-radius: 4px; font-family: monospace; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: #e0e0e0; max-height: 46vh; overflow: auto; }
.dlg-note { font-size: 11px; color: #e6a23c; }
.dlg-foot { padding: 8px 16px; border-top: 1px solid #2a2a4a; background: #14142a; }
.dlg-hint { font-size: 11px; color: #777; }
.tooltip { position: fixed; background: #1a1a2e; border: 1px solid #e67e22; padding: 5px 10px; border-radius: 4px; font-size: 12px; color: #e67e22; z-index: 100; pointer-events: none; white-space: pre-line; max-width: 70vw; }
</style>
