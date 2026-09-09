<template>
  <div class="gate-fragment">
    <div class="decision-summary" :class="`decision-${decisionSummary.tone}`">
      <strong>{{ decisionSummary.label }}</strong>
      <span>{{ decisionSummary.text }}</span>
    </div>

    <!-- subagent capability：只展示本次命令与能力边界，不提供扩权编辑入口 -->
    <div v-if="isCapability" class="sa-info capability-info">
      <div class="sa-row"><span class="sa-label">能力</span><span>{{ capability }}</span></div>
      <div class="sa-row"><span class="sa-label">范围</span><span>{{ capabilityScope }}</span></div>
      <div v-if="requestReason" class="sa-row"><span class="sa-label">理由</span><span class="sa-justification">{{ requestReason }}</span></div>
      <div class="sa-row"><span class="sa-label">说明</span><span>只批准当前这条命令；worker 会在批准后重新启动，不会获得持续权限。</span></div>
    </div>

    <!-- sandbox-allow：理由 + 可写路径 -->
    <div v-if="isSandboxAllow" class="sa-info">
      <div v-if="justification" class="sa-row">
        <span class="sa-label">理由</span>
        <span class="sa-justification">{{ justification }}</span>
      </div>
      <div v-if="writePaths.length" class="sa-row">
        <span class="sa-label">额外可写</span>
        <span class="sa-paths"><code v-for="path in writePaths" :key="path" class="sa-path">{{ path }}</code></span>
      </div>
      <div class="sa-row">
        <span class="sa-label">执行时限</span>
        <span>{{ timeout === undefined ? '默认' : `${timeout} 秒` }}（仅批准后生效）</span>
      </div>
      <div class="sa-row">
        <span class="sa-label">内存上限</span>
        <span>{{ memoryMb === undefined ? `默认 1GiB（${defaultMemoryMb} MB）` : `${memoryMb} MB` }}（超出即终止进程组）</span>
      </div>
    </div>

    <!-- sandbox-allow 风险提示：full-access 仍要展示命令审计结果。 -->
    <div v-if="isSandboxAllow && permission === 'full-access'" class="sandbox-warning">
      <strong>🔴 完全取消文件系统沙箱</strong>
      <span>本次命令可读写当前用户本来有权限访问的任意路径；这不是“额外开放某个目录”。</span>
    </div>
    <div v-if="isSandboxAllow && rules.length" class="sandbox-risk">
      <div class="paths-header">⚠️ 命令审计命中 {{ rules.length }} 项</div>
      <div v-for="(rule, index) in rules" :key="index" class="rule-row">
        <code class="rule-pattern">{{ rule.name }}</code>
        <span v-if="rule.matched && rule.matched.length" class="rule-matched">{{ rule.matched.join(' ') }}</span>
        <span class="rule-tip">{{ rule.tip }}</span>
      </div>
    </div>

    <!-- 云端模型审核意见（仅 audit） -->
    <div v-if="!isSandboxAllow && !isCapability && review" class="review-block">
      <div class="review-header">
        🤖 云端模型审核
        <span class="verdict-badge" :class="verdictMeta.cls">{{ verdictMeta.label }}</span>
      </div>
      <div v-if="review.reason" class="review-reason">{{ review.reason }}</div>
      <div v-if="review.suggestion" class="review-suggestion">💡 {{ review.suggestion }}</div>
      <div v-if="review.opinion" class="review-opinion">{{ review.opinion }}</div>
    </div>

    <!-- 规则列表（仅 audit） -->
    <div v-if="!isSandboxAllow && !isCapability" @click="showRules = !showRules" class="collapse-header" title="点击展开/收起规则">
      {{ showRules ? '▼' : '▶' }} {{ rules.length }} 条规则匹配
    </div>
    <div v-if="!isSandboxAllow && !isCapability && showRules" class="collapse-body">
      <div v-for="(rule, index) in rules" :key="index" class="rule-row">
        <code class="rule-pattern">{{ rule.name }}</code>
        <span v-if="rule.matched && rule.matched.length" class="rule-matched">{{ rule.matched.join(' ') }}</span>
        <span class="rule-tip">{{ rule.tip }}</span>
      </div>
    </div>

    <!-- 目录授权（仅升权申请窗口；命令链整体作为一次审批单元） -->
    <div v-if="isSandboxAllow && permission === 'write-paths' && rules.length === 0 && candidatePaths.length" class="paths-block">
      <div class="paths-header">📁 目录授权 <span class="paths-sub">（当前命令链整体一次执行）</span></div>
      <div v-for="path in candidatePaths" :key="path" class="path-row">
        <code class="path-dir">{{ path }}</code>
        <span class="path-state">{{ pathState(path) }}</span>
        <button v-if="!coveredBy(path, persistentRoots)" data-name="path-persistent" @click="pathAction(path, 'allow')" class="btn btn-allow btn-sm" title="长期可写；命中后 sandbox-allow 可免审批">长期信任</button>
        <button v-if="!coveredBy(path, sessionTrustedRoots) && !coveredBy(path, sessionWriteRoots) && !coveredBy(path, persistentRoots)" data-name="path-session-trust" @click="pathAction(path, 'session-trust')" class="btn btn-trust btn-sm" title="本 session 可写，后续 sandbox-allow 可免审批">本 session 信任</button>
        <button data-name="path-block" @click="pathAction(path, 'block')" class="btn btn-deny btn-sm" title="该目录以后直接拦截">黑名单</button>
      </div>
      <div class="paths-hint">目录授权只对无风险命令提供快捷设置。长期信任 = 跨 session 可写并可免 sandbox-allow 审批；本 session 信任 = 当前 session 可写并可免审；黑名单 = 长期拦截。点击授权动作会同时批准当前命令链，&&、;、管道和重定向也包含在内。</div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from "vue";
import { isPathCovered, pathTrustState } from "../../domain/gate/highlights.js";
import { gateDecisionSummary } from "../../domain/gate/summary.js";

const props = defineProps({
  isSandboxAllow: Boolean,
  isCapability: Boolean,
  permission: { type: String, default: "" },
  writePaths: { type: Array, default: () => [] },
  justification: { type: String, default: "" },
  capability: { type: String, default: "" },
  capabilityScope: { type: String, default: "" },
  requestReason: { type: String, default: "" },
  timeout: { type: [Number, String], default: undefined },
  memoryMb: { type: [Number, String], default: undefined },
  rules: { type: Array, default: () => [] },
  review: { type: Object, default: null },
  candidatePaths: { type: Array, default: () => [] },
  persistentRoots: { type: Array, default: () => [] },
  sessionWriteRoots: { type: Array, default: () => [] },
  sessionTrustedRoots: { type: Array, default: () => [] },
  verdictMeta: { type: Object, required: true },
  defaultMemoryMb: { type: Number, default: 1024 },
});

const emit = defineEmits(["path-action"]);
const showRules = ref(false);
const decisionSummary = computed(() => gateDecisionSummary({
  kind: props.isCapability ? "capability" : props.isSandboxAllow ? "sandbox-allow" : "audit",
  permission: props.permission,
  capability: props.capability,
  rules: props.rules,
  review: props.review,
}));

function coveredBy(path, roots) {
  return isPathCovered(path, roots);
}
function pathState(path) {
  return pathTrustState(path, {
    persistentRoots: props.persistentRoots,
    sessionTrustedRoots: props.sessionTrustedRoots,
    sessionWriteRoots: props.sessionWriteRoots,
  });
}
function pathAction(path, list) {
  emit("path-action", { path, list });
}
</script>

<style scoped>
.decision-summary { padding: 8px 16px; border-top: 1px solid #2a2a4a; display: flex; flex-direction: column; gap: 3px; font-size: 12px; line-height: 1.5; }
.decision-summary strong { font-size: 11px; }
.decision-info { background: #131328; color: #a9b1d6; }
.decision-warning { background: #2a1a0a; color: #f0c674; }
.decision-danger { background: #3a1a1a; color: #ffb4b4; }
.sa-info { padding: 10px 16px; border-top: 1px solid #2a2a4a; display: flex; flex-direction: column; gap: 8px; }
.sa-row { display: flex; gap: 10px; align-items: baseline; }
.sa-label { flex-shrink: 0; font-size: 11px; color: #888; }
.sa-justification { font-size: 13px; color: #e0e0e0; line-height: 1.6; }
.sa-paths { display: flex; flex-wrap: wrap; gap: 6px; }
.sa-path { color: #7aa2f7; background: #1a1a3e; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 12px; }
.path-state { flex-shrink: 0; color: #aaa; font-size: 11px; }
.btn-trust { color: #c792ea; background: #241b32; border-color: #c792ea55; }
.sandbox-warning { padding: 10px 16px; border-top: 1px solid #ff6b6b55; background: #3a1a1a; color: #ffb4b4; display: flex; flex-direction: column; gap: 4px; font-size: 12px; line-height: 1.5; }
.sandbox-risk { padding: 8px 16px; border-top: 1px solid #e67e2255; background: #2a1a0a; }
.paths-block { padding: 8px 16px; border-top: 1px solid #2a2a4a; background: #14142a; }
.paths-header { font-size: 12px; color: #7aa2f7; margin-bottom: 6px; }
.paths-sub { color: #888; font-size: 11px; }
.path-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.path-dir { flex: 1; color: #e0e0e0; background: #0d0d1a; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 12px; word-break: break-all; }
.paths-hint { font-size: 11px; color: #666; margin-top: 4px; }
.btn-sm { padding: 2px 8px; font-size: 11px; }
.review-block { padding: 8px 16px; border-top: 1px solid #2a2a4a; background: #131328; }
.review-header { font-size: 12px; color: #7aa2f7; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
.verdict-badge { font-size: 11px; padding: 1px 8px; border-radius: 3px; }
.verdict-badge.v-safe { color: #7ee787; background: #12261a; border: 1px solid #7ee78744; }
.verdict-badge.v-risky { color: #e67e22; background: #2a1a0a; border: 1px solid #e67e2255; }
.verdict-badge.v-dangerous { color: #ff6b6b; background: #3a1a1a; border: 1px solid #ff6b6b55; }
.verdict-badge.v-error { color: #999; background: #1a1a2e; border: 1px solid #444; }
.review-reason { font-size: 13px; color: #e0e0e0; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.review-suggestion { font-size: 12px; color: #7aa2f7; margin-top: 3px; }
.review-opinion { margin-top: 6px; padding: 6px 10px; background: #0d0d1a; border-left: 2px solid #7aa2f7; border-radius: 3px; font-size: 12.5px; color: #d0d0e0; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.rule-row { padding: 3px 6px; margin-bottom: 2px; border-left: 2px solid #ff6b6b44; display: flex; gap: 6px; }
.rule-pattern { color: #ce9178; background: #0d0d1a; padding: 1px 4px; border-radius: 2px; }
.rule-matched { color: #e67e22; background: #2a1a0a; padding: 1px 4px; border-radius: 2px; font-family: monospace; font-size: 11px; }
.rule-tip { color: #999; }
</style>

<style scoped>
.gate-fragment { display: contents; }
</style>
