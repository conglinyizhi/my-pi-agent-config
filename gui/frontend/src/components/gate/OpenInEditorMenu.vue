<template>
  <!-- "在编辑器打开"：点开先弹一个小菜单（本机有哪些编辑器、各自能干什么） -->
  <span class="editor-menu">
    <button class="editor-btn" :disabled="items.length === 0" :title="hint" data-name="editor-menu" @click="toggle">
      🧷 {{ label }}<span class="caret">▾</span>
    </button>
    <div v-if="open" class="editor-pop" @mouseleave="open = false">
      <button
        v-for="(item, index) in items"
        :key="index"
        class="editor-item"
        :data-name="`editor-item-${item.editorId}`"
        @click="run(item)"
      >{{ item.text }}</button>
    </div>
    <span v-if="note" class="editor-note" :class="{ 'editor-note-bad': noteBad }">{{ note }}</span>
  </span>
</template>

<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { usePlatform } from "../../platform/index.js";
import { editorItems } from "../../domain/gate/editor-items.js";

const props = defineProps({
  label: { type: String, default: "在编辑器打开" },
  /** { path?, line?, left?, right?, patchText? }：给得出什么就列什么动作 */
  request: { type: Object, default: () => ({}) },
});

const platform = usePlatform();
const editors = ref([]);
const open = ref(false);
const note = ref("");
const noteBad = ref(false);

const items = computed(() => editorItems(editors.value, props.request));
const hint = computed(() => (items.value.length === 0 ? "本机没找到能处理这个的编辑器" : "选一个编辑器"));

async function load() {
  try {
    editors.value = (await platform.editor?.list?.()) ?? [];
  } catch {
    editors.value = []; // 探测失败就当没有，别把按钮变成报错现场
  }
}

async function run(item) {
  open.value = false;
  try {
    const result = await platform.editor.open({ editorId: item.editorId, target: item.target });
    noteBad.value = !result?.ok;
    note.value = result?.ok ? "已交给 " + (result.editor?.label ?? item.editorId) : String(result?.error ?? "打不开");
  } catch (error) {
    noteBad.value = true;
    note.value = String(error?.message ?? error);
  }
  setTimeout(() => { note.value = ""; }, 4000);
}

function toggle() {
  open.value = !open.value;
}

onMounted(load);
watch(() => props.request, () => { open.value = false; });
</script>

<style scoped>
.editor-menu { position: relative; display: inline-flex; align-items: center; gap: 8px; }
.editor-btn { padding: 4px 10px; font-size: 12px; color: #a9b1d6; background: #1f1f38; border: 1px solid #2a2a4a; border-radius: 4px; cursor: pointer; }
.editor-btn:hover:not(:disabled) { color: #c0caf5; border-color: #4ec9b055; }
.editor-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.caret { margin-left: 4px; color: #666; }
.editor-pop { position: absolute; top: 100%; left: 0; margin-top: 4px; z-index: 60; display: flex; flex-direction: column; min-width: 220px; background: #14142a; border: 1px solid #2a2a4a; border-radius: 6px; box-shadow: 0 10px 30px #000a; overflow: hidden; }
.editor-item { padding: 6px 12px; text-align: left; font-size: 12px; color: #ccc; background: transparent; border: 0; cursor: pointer; }
.editor-item:hover { background: #22223f; color: #fff; }
.editor-note { font-size: 11px; color: #6ee7a8; }
.editor-note-bad { color: #e6a23c; }
</style>
