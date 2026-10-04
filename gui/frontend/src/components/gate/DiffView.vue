<template>
  <!-- 对比视图：块级渲染（rows 段 + gap 段），浮层与审核窗的合并面板共用 -->
  <div class="diff">
    <template v-for="(block, blockIndex) in blocks" :key="blockIndex">
      <div v-if="block.type === 'gap'" class="gap">⋯ 跳过 {{ block.count }} 行未改动</div>
      <template v-else>
        <div
          v-for="(row, rowIndex) in block.rows"
          :key="`${blockIndex}-${rowIndex}`"
          class="row"
          :class="`row-${row.kind}`"
        >
          <span class="gut">{{ gutterOf(row).old }}</span>
          <span class="gut">{{ gutterOf(row).next }}</span>
          <span class="sign">{{ signOf(row.kind) }}</span>
          <span class="txt" v-html="intraHtml(row.text, row.intra)"></span>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup>
import { gutterOf, intraHtml, signOf } from "../../domain/gate/diff-render.js";

defineProps({
  /** DiffBlock[]：{ type: "rows", rows } | { type: "gap", count } */
  blocks: { type: Array, default: () => [] },
});
</script>

<style scoped>
.diff { font-family: monospace; font-size: 12.5px; line-height: 1.55; background: #0d0d1a; border: 1px solid #1f1f38; border-radius: 4px; overflow: auto; max-height: 46vh; }
.row { display: flex; gap: 8px; padding: 0 8px; white-space: pre-wrap; word-break: break-word; }
.row .gut { width: 3.2em; flex: none; text-align: right; color: #555a6b; user-select: none; }
.row .sign { width: 1em; flex: none; color: #888; user-select: none; }
.row .txt { flex: 1; min-width: 0; }
.row-add { background: #16321f; }
.row-add .sign { color: #6ee7a8; }
.row-del { background: #3a1a1a; }
.row-del .sign { color: #ff8080; }
.row-meta { color: #7aa2f7; background: #14142a; }
.row-context .txt { color: #c8cfe0; }
/* 行内差异：底色更重一档，眼睛直接落到改的那几个字符上 */
.row .txt :deep(.intra) { background: #ffffff22; border-radius: 2px; }
.row-add .txt :deep(.intra) { background: #6ee7a844; }
.row-del .txt :deep(.intra) { background: #ff808044; }
.gap { padding: 2px 8px; color: #666; background: #12121f; font-style: italic; }
</style>
