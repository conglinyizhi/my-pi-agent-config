<template>
  <section data-name="agent-list" class="agents-view">
    <header class="agents-header">
      <div class="agents-title-row">
        <h1>Subagent 批次</h1>
        <span class="count-badge">{{ workers.length }}</span>
      </div>
      <label class="feedback-toggle" data-name="feedback-toggle-wrap">
        <input type="checkbox" data-name="feedback-toggle" :checked="feedback" @change="$emit('toggle-feedback', $event)" />
        <span>反馈模式（新 worker 仅 read/bash/be-*）</span>
      </label>
      <p v-if="feedbackNote" class="note">{{ feedbackNote }}</p>
    </header>

    <div class="worker-list">
      <div v-for="worker in workers" :key="worker.id" data-name="agent-item" :class="['agent-item', { active: selectedId === worker.id }]" @click="$emit('select', worker.id)">
        <span class="status-icon">{{ statusIcon(worker.status) }}</span>
        <div class="worker-info">
          <div class="worker-title">{{ worker.task.slice(0, 40) }}</div>
          <div class="worker-id">{{ worker.id }} · {{ statusLabel(worker.status) }}<span v-if="activityState(worker).label" :class="['activity', `activity-${activityState(worker).level}`]"> · {{ activityState(worker).label }}</span></div>
        </div>
        <span class="row-chevron">›</span>
      </div>
      <div v-if="workers.length === 0" class="empty-list">暂无运行中的批次</div>
    </div>
  </section>
</template>

<script setup>
defineProps({
  workers: { type: Array, default: () => [] },
  selectedId: { type: String, default: null },
  feedback: Boolean,
  feedbackNote: { type: String, default: "" },
  statusIcon: { type: Function, required: true },
  statusLabel: { type: Function, required: true },
  activityState: { type: Function, required: true },
});
defineEmits(["select", "toggle-feedback"]);
</script>

<style scoped>
.agents-view { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.agents-header { padding: 10px 14px; border-bottom: 1px solid #2a2a4a; }
.agents-title-row { display: flex; justify-content: space-between; align-items: center; }
.agents-title-row h1 { font-size: 14px; color: #7aa2f7; margin: 0; }
.count-badge { font-size: 11px; color: #565f89; }
.feedback-toggle { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11px; color: #a9b1d6; cursor: pointer; }
.feedback-toggle input { accent-color: #e0af68; cursor: pointer; }
.note { font-size: 10px; color: #565f89; margin: 6px 0 0; line-height: 1.4; }
.worker-list { flex: 1; overflow-y: auto; }
.agent-item { padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #1a1a3e; display: flex; align-items: center; gap: 6px; border-left: 3px solid transparent; }
.agent-item:hover { background: #16213e; }
.agent-item.active { background: #1a2a4a; border-left-color: #7aa2f7; }
.status-icon { font-size: 14px; flex-shrink: 0; }
.worker-info { flex: 1; min-width: 0; }
.worker-title { font-size: 12px; font-weight: 500; line-height: 1.3; word-break: break-word; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.worker-id { font-size: 10px; color: #565f89; }
.activity-waiting { color: #c792ea; }
.activity-quiet { color: #e0af68; }
.activity-stalled { color: #f7768e; }
.row-chevron { color: #565f89; font-size: 14px; flex-shrink: 0; }
.empty-list { padding: 20px; text-align: center; color: #565f89; font-size: 13px; }
</style>
