<!--
  调试面板：后端推送完整状态 (debug_init)

  场景：agent 对话的调试面板需要展示 system prompt、消息历史、工具调用等。
  如果前端自己拼凑这些数据，会出现顺序错乱、数据不完整、与后端实际发送不一致等问题。

  方案：后端在 SSE 开始时推一个一次性快照 debug_init，前端用此数据重建面板。
  后续增量事件（tool_call/tool_result/assistant）仍来自后端。

  关键设计：
  - 单一真相来源：调试面板的数据只从后端来，不由前端 addDebugEntry 渲染
  - 一次性快照 + 增量更新
  - 不需要前端手动管理 system_prompt/user 等条目的插入位置

  === 后端 SSE (chat.ts) ===
-->

<!--
// 在 SSE 流开始时发送完整快照
emitSse('debug_init', {
  messages: fullMessages.map((m) => ({ role: m.role, content: m.content, tool_call_id: m.tool_call_id })),
  skills: skills.map((s) => ({ name: s.name, description: s.description, path: s.path })),
  tools: allTools,
});
-->

<template>
  <div class="debug-panel">
    <h2>调试详情</h2>
    <div class="debug-entries">
      <template v-for="entry in debugEntries" :key="entry._time">
        <!-- system prompt -->
        <div v-if="entry.type === 'system_prompt'" class="entry system">
          <button @click="entry._expanded = !entry._expanded">
            📋 System Prompt ({{ entry.content.length }} 字符)
          </button>
          <pre v-if="entry._expanded">{{ entry.content }}</pre>
        </div>

        <!-- user / assistant -->
        <div v-else-if="entry.type === 'user' || entry.type === 'assistant'" class="entry">
          <span>{{ entry.type === 'user' ? '👤' : '🤖' }} {{ entry.type }}</span>
          <pre>{{ entry.content }}</pre>
        </div>

        <!-- tool call / result -->
        <div v-else-if="entry.type === 'tool_call'" class="entry tool-call">
          ⚡ {{ entry.name }}
          <pre v-if="entry._expanded">{{ JSON.stringify(entry.args, null, 2) }}</pre>
        </div>
        <div v-else-if="entry.type === 'tool_result'" class="entry tool-result">
          ✅ {{ entry.name }}
          <pre v-if="entry._expanded">{{ entry.result }}</pre>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
// 核心：收到 debug_init 后完全替换 debugEntries
function handleSseEvent(parsed: any) {
  if (parsed.type === 'debug_init') {
    // 清空，从后端快照重建
    debugEntries.value = [];

    // 先展示 skill 和工具清单
    if (parsed.skills?.length) {
      debugEntries.value.push({ type: 'skills_loaded', ... });
    }
    if (parsed.tools?.length) {
      debugEntries.value.push({ type: 'tools_loaded', ... });
    }

    // 按后端实际消息顺序逐条添加
    for (const msg of parsed.messages || []) {
      if (msg.role === 'system') {
        debugEntries.value.push({ type: 'system_prompt', content: msg.content, _expanded: false });
      } else if (msg.role === 'user') {
        debugEntries.value.push({ type: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        debugEntries.value.push({ type: 'assistant', content: msg.content });
      } else if (msg.role === 'tool') {
        // 解析 tool 消息区分 call / result
        const d = JSON.parse(msg.content);
        if (d.args) {
          debugEntries.value.push({ type: 'tool_call', name: d.tool, args: d.args, _expanded: false });
        } else {
          debugEntries.value.push({ type: 'tool_result', name: d.tool, result: d.output, _expanded: false });
        }
      }
    }
    return;
  }

  // 后续增量事件只追加，不重建
  if (parsed.type === 'tool_call') {
    debugEntries.value.push({ type: 'tool_call', name: parsed.name, args: parsed.args });
  }
  if (parsed.type === 'tool_result') {
    debugEntries.value.push({ type: 'tool_result', name: parsed.name, result: parsed.result });
  }
}
</script>
