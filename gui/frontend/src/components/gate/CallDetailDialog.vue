<template>
  <!-- 全屏拟态对话框：留 margin 露出黑色遮罩。点遮罩**不**关闭，只有关闭按钮与 Esc 收工 -->
  <div class="dlg-backdrop">
    <section class="dlg" data-name="call-detail" role="dialog" aria-modal="true">
      <header class="dlg-head">
        <div class="dlg-title">
          <span class="dlg-tool">{{ callTitle(chip.call) }}</span>
          <span class="dlg-kind" :class="`kind-${chip.tone}`">{{ chip.tone === "shell" ? "可执行 shell" : "文件编辑" }}</span>
          <span v-if="!chip.literal" class="dlg-vague">参数不是字面量</span>
        </div>
        <div class="dlg-actions">
          <OpenInEditorMenu :request="editorRequest" />
          <button data-name="call-detail-close" class="dlg-close" @click="$emit('close')">关闭 ✕</button>
        </div>
      </header>

      <div class="dlg-meta">
        <span>{{ lineLabel }}</span>
        <span v-if="chip.label">{{ chip.label }}</span>
        <span v-if="sizeLabel">{{ sizeLabel }}</span>
        <span v-if="body.kind === 'source' && !chip.literal">这一处看不到内容，原文照摆</span>
        <span v-else-if="chip.call.mode">{{ chip.call.mode }}</span>
      </div>

      <div class="dlg-body">
        <template v-if="body.kind === 'diff'">
          <template v-if="diffBlocks.length">
            <div class="blk-head">改动（没变的部分折起来了）</div>
            <DiffView :blocks="diffBlocks" />
          </template>
          <template v-else>
            <div class="blk-head">改动太大，不逐行对比，两段分开摆</div>
            <div class="blk">
              <div class="blk-head blk-old">原内容</div>
              <pre class="blk-body" v-html="escaped(body.old)"></pre>
            </div>
            <div class="blk">
              <div class="blk-head blk-new">改成</div>
              <pre class="blk-body" v-html="escaped(body.new)"></pre>
            </div>
          </template>
        </template>
        <template v-else-if="body.kind === 'patch'">
          <div class="blk-head">补丁原文（{{ patchStat }}，照摆不重算）</div>
          <DiffView :blocks="patchBlocks" />
        </template>
        <div v-else-if="body.kind === 'content'" class="blk">
          <div class="blk-head">将写入的内容</div>
          <pre class="blk-body" v-html="previewHtml"></pre>
        </div>
        <div v-else class="blk">
          <div class="blk-head">{{ chip.tone === "shell" ? "命令" : "调用" }}</div>
          <pre class="blk-body" @mouseover="onHover" @mouseout="tip = ''"><div v-for="(html, index) in bodyLines" :key="index" :class="{ 'blk-soft': index > 0 }" v-html="html"></div></pre>
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
import { watch } from "vue";
import { callTitle, clipMarks } from "../../domain/gate/script-fold.js";
import { renderHighlightedCommand } from "../../domain/gate/highlights.js";
import { clipTokens, colorTokens, composeCodeHtml } from "../../domain/gate/code-color.js";
import { shellBreakPoints } from "../../domain/gate/shell-breaks.js";
import { blocksOfRows } from "../../domain/gate/diff-render.js";
import { patchCounts, patchToRows } from "../../domain/gate/patch-rows.js";
import { collapseContext, lineDiff } from "../../../../../lib/text-diff.ts";
import DiffView from "./DiffView.vue";
import OpenInEditorMenu from "./OpenInEditorMenu.vue";

const props = defineProps({
  /** 折叠模型里的一颗芯片（含 pi 侧给的事实） */
  chip: { type: Object, required: true },
  /** 展示用脚本文本：非字面量时按区间切原文 */
  source: { type: String, default: "" },
  /** 合并后的标记（全局坐标），用来看被折住的危险片段 */
  marks: { type: Array, default: () => [] },
  /** 展示脚本的语法 token（全局坐标）：调用原文那一块直接裁着用 */
  tokens: { type: Array, default: () => [] },
});
const emit = defineEmits(["close"]);

const tip = ref("");
const tipPos = ref({});

const body = computed(() => {
  const call = props.chip?.call ?? {};
  if (call.replacement) {
    return { kind: "diff", old: call.replacement.old, new: call.replacement.new, truncated: call.replacement.truncated };
  }
  if (typeof call.patchText === "string") {
    return { kind: "patch", text: call.patchText, truncated: call.truncated === true };
  }
  if (typeof call.contentPreview === "string") {
    return { kind: "content", text: call.contentPreview, truncated: call.truncated === true };
  }
  return { kind: "source", text: (props.source ?? "").slice(call.startOffset, call.endOffset) };
});

/** 对比块：改动不大时把没变的部分折起来，太大就退回两块分开摆 */
const diffBlocks = computed(() => {
  if (body.value.kind !== "diff") return [];
  const result = lineDiff(body.value.old, body.value.new);
  if (result.status === "too-large") return [];
  return collapseContext(result.rows, 3);
});

/** 交给编辑器看的东西：有绝对路径就打开文件，有新旧文就看差异，有补丁就开补丁 */
const editorRequest = computed(() => {
  const call = props.chip?.call ?? {};
  return {
    ...(call.absPath ? { path: call.absPath } : call.paths?.length ? { path: call.paths[0] } : {}),
    ...(typeof call.line === "number" ? { line: call.line } : {}),
    ...(call.replacement ? { left: call.replacement.old, right: call.replacement.new } : {}),
    ...(typeof call.patchText === "string" ? { patchText: call.patchText } : {}),
  };
});

const patchBlocks = computed(() => (body.value.kind === "patch" ? blocksOfRows(patchToRows(body.value.text)) : []));
const patchStat = computed(() => {
  const counts = patchCounts(patchToRows(body.value.kind === "patch" ? body.value.text : ""));
  return `+${counts.added} / -${counts.removed}`;
});
const diffTooLarge = computed(() => body.value.kind === "diff" && diffBlocks.value.length === 0);

/**
 * 这段内容该按什么语法上色：跟着目标路径的后缀走。
 * 认不出来的就当纯文本（宁可不上色，也别拿错语法乱涂）。
 */
function langFromPath(path) {
  const value = typeof path === "string" ? path.toLowerCase() : "";
  if (/\.(m|c)?jsx?$/.test(value)) return "javascript";
  if (/\.(ts|mts|cts)$/.test(value) || /\.tsx$/.test(value)) return "javascript";
  if (/\.jsonc?$/.test(value)) return "javascript";
  return "";
}

/** 预览正文（pi 侧解出来的字符串）不在脚本原文里，得单独上色 */
const previewTokens = ref([]);
let previewRequest = 0;

async function refreshPreviewTokens() {
  const request = ++previewRequest;
  // shell 芯片按 bash 上色（它没有文件路径可猜），其余按文件后缀
  const lang = props.chip?.tone === "shell" ? "bash" : langFromPath(props.chip?.call?.displayPath);
  const text = body.value.kind === "diff" ? "" : body.value.text;
  if (!lang || !text) {
    previewTokens.value = [];
    return;
  }
  const got = await colorTokens(text, lang);
  if (request === previewRequest) previewTokens.value = got;
}
watch(() => [props.chip, body.value.kind], refreshPreviewTokens, { immediate: true });

/**
 * 内容区按视觉行渲染。
 * shell 芯片的 command 是一长条，按 ; | && 折开读起来才清楚；
 * 断点只是切渲染，文本偏移照旧（每段各自裁 token / mark）。
 */
const bodyLines = computed(() => {
  if (body.value.kind !== "source") return [];
  const call = props.chip.call;
  const text = body.value.text;
  const base = call.startOffset ?? 0;
  const end = call.endOffset ?? base;
  const marks = clipMarks(props.marks, base, end);
  const paint = (piece, from, to, pieceMarks) => {
    if (props.tokens.length === 0) return renderHighlightedCommand(piece, pieceMarks);
    return composeCodeHtml(piece, clipTokens(props.tokens, from, to), pieceMarks);
  };
  if (props.chip?.tone !== "shell") {
    return [paint(text, base, end, marks)];
  }
  const cuts = shellBreakPoints(text).filter((at) => at > 0 && at < text.length);
  const out = [];
  let cursor = 0;
  for (const stop of cuts.concat([text.length])) {
    const piece = text.slice(cursor, stop);
    if (piece.length > 0) out.push(paint(piece, base + cursor, base + stop, clipMarks(marks, cursor, stop)));
    cursor = stop;
  }
  return out.length > 0 ? out : [""];
});

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

/** 预览正文：能认路径后缀就上色，认不出来只转义 */
const previewHtml = computed(() =>
  previewTokens.value.length === 0
    ? escaped(body.value.text)
    : composeCodeHtml(body.value.text, previewTokens.value, []),
);

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
.dlg-actions { display: flex; align-items: center; gap: 10px; }
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
/* 软换行的续行：缩一级，看着还是同一行 */
.blk-soft { padding-left: 24px; opacity: 0.92; }
</style>