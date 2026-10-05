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

    <!-- 这一行不能折：<pre> 里元素之间的空白会被当正文渲染，所以标签必须贴着写 -->
    <div class="cmd-wrap">
      <pre ref="cmdBox" class="cmd-area" @mouseover="onHover" @mouseout="onLeave"><div v-for="line in displayLines" :key="line.no" class="code-line"><span class="code-no" :class="{ 'code-no-bad': issueLines.includes(line.no) }">{{ line.no }}</span><span class="code-text"><template v-for="(part, index) in line.parts" :key="index"><span v-if="part.kind === 'text'" v-html="partHtml(part)"></span><button v-else class="fold-chip" :class="chipClass(part.chip)" :data-name="'fold-chip-' + part.chip.index" :title="chipTitle(part.chip)" @click="openDetail(part.chip)">{{ part.chip.warned ? "⚠ " : "" }}{{ part.chip.label }}</button></template></span></div></pre>
    </div>
    <div v-if="chips.length" class="fold-legend">
      灰 = 改文件，橙 = 可执行 shell（$$SHELL$$）；点芯片看具体改动
    </div>

    <CallDetailDialog
      v-if="detail"
      :chip="detail"
      :source="command"
      :marks="mergedMarks"
      :tokens="tokens"
      @close="detail = null"
    />
    <div v-if="tip" class="tooltip" :class="tipTone" :style="tipPos">{{ tip }}</div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { splitLines } from "../../domain/gate/code-lines.js";
import { mergeEnvHighlights, renderHighlightedCommand } from "../../domain/gate/highlights.js";
import { envNoteHighlights } from "../../domain/gate/env-notes.js";
import { mergeVarHighlights, varRenderHighlights } from "../../domain/gate/var-renders.js";
import { foldScript } from "../../domain/gate/script-fold.js";
import { clipTokens, colorTokens, composeCodeHtml } from "../../domain/gate/code-color.js";
import CallDetailDialog from "./CallDetailDialog.vue";

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
  /** 有问题的行号：行号栏里标黄（静态扫描报的那些行） */
  issueLines: { type: Array, default: () => [] },
  /** pi 侧算好的赋值解析结果：{name, raw, start, end, value?|reason?} */
  envNotes: { type: Array, default: () => [] },
  /** pi 侧算好的变量渲染值：{name, value?, source, target, kind, known, reason?} */
  varRenders: { type: Array, default: () => [] },
  /** 要折成芯片的调用（pi 侧给事实；空数组 = 一行不折，原文照出） */
  editCalls: { type: Array, default: () => [] },
  /** 语法着色的语言（shiki 的 lang id）；空 = 不上色 */
  colorLang: { type: String, default: "" },
  current: { type: Number, default: 0 },
});

const emit = defineEmits(["update:current"]);
const cmdBox = ref(null);
/** 打开着的细节对话框：一颗芯片（模型给的，含 pi 侧事实） */
const detail = ref(null);
const tip = ref("");
/** tip 的底色：rule=黄（旧行为），env=绿（赋值解析出来了），env-unknown=灰（赋值没解析出来），var/var-unknown=蓝/灰（变量渲染值） */
const tipTone = ref("rule");
const tipPos = ref({});

const mergedMarks = computed(() => {
  // 先按老路径合并规则与赋值高亮，再叠变量渲染值（重叠时后者让位，绿框不被蓝框盖）
  const ruleAndEnv = mergeEnvHighlights(envNoteHighlights(props.command, props.envNotes), props.highlights);
  return mergeVarHighlights(varRenderHighlights(props.command, props.varRenders), ruleAndEnv);
});
const foldModel = computed(() =>
  foldScript(props.command, props.editCalls, mergedMarks.value, { warnMarks: props.highlights }),
);
// <pre> 里要贴着写元素，所以分段渲染在模板里完成，这里只算出片段
const segments = computed(() => foldModel.value.segments);
const chips = computed(() => foldModel.value.chips);

/** 语法着色的 token（异步来；拿不到就退回不上色） */
const tokens = ref([]);
let tokenRequest = 0;

async function refreshTokens() {
  const request = ++tokenRequest;
  if (!props.colorLang) {
    tokens.value = [];
    return;
  }
  const got = await colorTokens(props.command, props.colorLang);
  if (request === tokenRequest) tokens.value = got; // 晚到的旧结果不能盖新的
}
watch(() => [props.command, props.colorLang], refreshTokens, { immediate: true });

function partHtml(part) {
  if (part.tokens.length === 0) return renderHighlightedCommand(part.text, part.marks);
  return composeCodeHtml(part.text, part.tokens, part.marks);
}
/** 显示行：行号栏与静态扫描里的"第 N 行"指的是同一份文本 */
const displayLines = computed(() => splitLines(segments.value, tokens.value));
function chipClass(chip) {
  return {
    "chip-file": chip.tone !== "shell",
    "chip-shell": chip.tone === "shell",
    "chip-warn": chip.warned,
    "chip-vague": !chip.literal,
  };
}
function chipTitle(chip) {
  const what = chip.tone === "shell" ? "这段 shell 命令" : "这次写入/改写";
  return `点击查看${what}的具体内容`;
}
function openDetail(chip) {
  detail.value = chip;
}

function scroll() {
  const model = foldModel.value;
  // 被折住的规则标记：滚动定位没有意义，改成把对应芯片的内容摆出来
  const owner = model.ruleOwner[props.current] ?? -1;
  if (owner >= 0) {
    openDetail(model.chips[owner]);
    return;
  }
  const position = model.ruleVisible.indexOf(props.current);
  if (position < 0) return;
  nextTick(() => {
    const marks = cmdBox.value?.querySelectorAll("mark.h") ?? [];
    marks.forEach((mark, index) => mark.classList.toggle("f", index === position));
    marks[position]?.scrollIntoView({ behavior: "smooth", block: "center" });
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
  // 变量渲染值用 mark.v（蓝=已知 / 灰=解析不了），与规则、赋值两种标记分开
  const isVar = target.tagName === "MARK" && target.classList.contains("v");
  if (!isRule && !isEnv && !isVar) return;
  tip.value = target.dataset.tip || "";
  tipTone.value = isRule
    ? "rule"
    : target.classList.contains("e-u") ? "env-unknown"
      : target.classList.contains("v-u") ? "var-unknown"
        : isVar ? "var" : "env";
  const rect = target.getBoundingClientRect();
  tipPos.value = { left: `${rect.left}px`, top: `${rect.bottom + 4}px` };
}
function onLeave() {
  tip.value = "";
}

onMounted(scroll);
// 被折住的高亮跳过去时会把细节对话框打开（折叠不是"看不到"，是"先不看"）
watch(() => props.current, scroll);
// 文本换了，之前打开的细节就作废
watch(() => [props.command, props.editCalls], () => {
  detail.value = null;
  scroll();
});
watch(() => props.highlights, scroll, { deep: true });
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
/* 脚本区是这扇窗的主体：给它保底高度，窗口拉高时空间归它，而不是空在下面。
   根是 display:contents，所以这条直接参与 .app 的 flex 布局。 */
.cmd-wrap { flex: 1 1 auto; min-height: 42vh; position: relative; display: flex; }
.fold-legend { padding: 4px 16px 8px; font-size: 11px; color: #777; }
/* 行号栏是一条自己的灰带（贴左边缘），和代码里的规则高亮区别开；
   行号与代码之间留 10px 灰区 */
.code-line { display: flex; gap: 0; }
.code-no {
  flex: 0 0 auto;
  width: 2.6em;
  padding: 0 10px 0 0;
  text-align: right;
  color: #4a5364;
  user-select: none;
}
.code-no-bad { color: #e6a23c; font-weight: 600; }
.code-text { flex: 1 1 auto; min-width: 0; padding: 0 12px 0 10px; }
/* 行号那条灰带画在容器上（不是每行各画一段）：代码再短，它也通到上下两头；
   37px 处那条是分隔线。宽度要和 .code-no 的盒子对齐 */
.cmd-area {
  flex: 1;
  margin: 0;
  padding: 10px 0;
  background: linear-gradient(
    to right,
    #0f1319 0,
    #0f1319 37px,
    #1d2431 37px,
    #1d2431 38px,
    transparent 38px
  ); background: #0d0d1a; font-family: monospace; font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-all; overflow-wrap: break-word; overflow: auto; color: #e0e0e0; outline: none; }
/* 芯片：灰=改文件，橙=可执行 shell。字号跟着正文走，别在 <pre> 里跳出来 */
.fold-chip { font-family: inherit; font-size: inherit; line-height: inherit; padding: 0 6px; margin: 0 1px; border-radius: 3px; border: 1px solid; cursor: pointer; vertical-align: baseline; }
.fold-chip.chip-file { color: #b9c0d0; background: #2a2a3d55; border-color: #555a6b; }
.fold-chip.chip-file:hover { background: #3a3a5566; color: #dfe4f0; }
.fold-chip.chip-shell { color: #e6a23c; background: #3a2a1233; border-color: #e6a23c88; }
.fold-chip.chip-shell:hover { background: #4a361688; }
.fold-chip.chip-warn { box-shadow: inset 0 0 0 1px #ff6b6b; }
.fold-chip.chip-vague { border-style: dashed; }
.tooltip { position: fixed; background: #1a1a2e; border: 1px solid #e67e22; padding: 5px 10px; border-radius: 4px; font-size: 12px; color: #e67e22; z-index: 100; pointer-events: none; white-space: pre-line; max-width: 70vw; }
.tooltip.rule::before { content: "⚠️ "; }
.tooltip.env { border-color: #4ec9b0; color: #4ec9b0; }
.tooltip.env::before { content: "✓ "; }
.tooltip.env-unknown { border-color: #888; color: #b0b0b0; }
.tooltip.env-unknown::before { content: "? "; }
.tooltip.var { border-color: #7aa2f7; color: #7aa2f7; }
.tooltip.var::before { content: "⇢ "; }
.tooltip.var-unknown { border-color: #888; color: #b0b0b0; }
.tooltip.var-unknown::before { content: "? "; }
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
/* 变量渲染值：蓝=已知（悬停看渲染值），灰=解析不了（悬停看原因）。与 envNotes 的绿框分开，互不遮盖 */
mark.v { background:#7aa2f722; color:#e0e0e0; padding:1px 2px; border-radius:2px; cursor:help; box-shadow: inset 0 0 0 1px #7aa2f755; transition:all 0.12s; }
mark.v:hover { background:#7aa2f744; }
mark.v-u { background:#88888822; box-shadow: inset 0 0 0 1px #88888855; }
mark.v-u:hover { background:#88888844; }
</style>

<style scoped>
.gate-fragment { display: contents; }
</style>
