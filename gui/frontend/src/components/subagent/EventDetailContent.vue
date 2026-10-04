<template>
  <template v-if="event">
    <template v-if="event.type === 'tool'">
      <div v-if="event.args !== undefined" class="detail-field"><label>参数</label><pre>{{ event.args }}</pre></div>
      <div v-if="event.preview !== undefined" class="detail-field"><label>增量输出</label><pre>{{ event.preview }}</pre></div>
      <div v-if="event.result !== undefined" class="detail-field"><label>最终结果</label><pre :class="{ err: event.ok === false }">{{ event.result }}</pre></div>
      <div v-if="event.ok !== undefined" class="detail-field inline"><label>状态</label><span :class="event.ok ? 'ok' : 'err'">{{ event.ok ? "成功" : "失败" }}</span></div>
    </template>
    <template v-else-if="event.type === 'assistant'"><div class="detail-field"><label>助手回复{{ event.final ? "（已结束）" : "（流式中）" }}</label><pre class="assistant-text">{{ event.text || "（空）" }}</pre></div></template>
    <template v-else-if="event.type === 'terminal'"><div class="detail-field"><label>{{ event.stream === "stderr" ? "stderr 原文" : "终端输出原文" }}</label><pre :class="{ err: event.stream === 'stderr' }">{{ event.text || "（空）" }}</pre></div></template>
    <template v-else-if="event.type === 'supplement'"><div class="detail-field"><label>Supplement sent to worker</label><pre class="supplement-text">{{ event.text || "（空）" }}</pre></div></template>
    <template v-else><div class="detail-field"><label>生命周期</label><pre>{{ event.state }} {{ event.message || "" }}</pre></div></template>
  </template>
  <div v-else class="empty-detail">该事件已不存在</div>
</template>

<script setup>
defineProps({ event: { type: Object, default: null } });
</script>

<style scoped>
.detail-field { margin-bottom: 14px; }
.detail-field label { display: block; font-size: 10px; color: #565f89; text-transform: uppercase; margin-bottom: 4px; }
.detail-field pre { margin: 0; background: #0d0d1a; border: 1px solid #16162a; border-radius: 4px; padding: 8px 10px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: #c0caf5; }
.detail-field pre.err { color: #f7768e; }
.detail-field .ok { color: #9ece6a; font-size: 12px; }
.detail-field .err { color: #f7768e; font-size: 12px; }
.assistant-text { max-height: none; }
.empty-detail { padding: 20px; text-align: center; color: #565f89; font-size: 13px; }
.supplement-text { color: #7dcfff; }
</style>
