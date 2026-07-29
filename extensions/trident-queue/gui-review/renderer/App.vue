<template>
  <div v-if="!initData" style="color:red;padding:20px">initData 为空</div>
  <div v-else style="display:flex;flex-direction:column;height:100vh;background:#1a1a2e;color:#e0e0e0">
    <header style="padding:10px 16px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center">
      <h1 style="font-size:15px;color:#7aa2f7;margin:0">⚓ 任务确认</h1>
      <span style="font-size:11px;color:#666">三叉戟 · 翻译结果审查</span>
    </header>

    <!-- 查看模式 -->
    <div v-if="mode === 'view'" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px">
      <div v-for="f in fields" :key="f.key" style="display:flex;flex-direction:column">
        <label style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">{{ f.label }}</label>
        <pre style="background:#0d0d1a;padding:10px 14px;border-radius:6px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0;min-height:24px">{{ f.value || '(未识别)' }}</pre>
      </div>
    </div>

    <!-- 编辑模式 -->
    <div v-if="mode === 'edit'" style="flex:1;padding:16px;display:flex;flex-direction:column">
      <label style="font-size:11px;color:#e0af68;margin-bottom:6px">直接修改整个任务描述（保持格式）</label>
      <textarea v-model="editText" style="flex:1;background:#0d0d1a;color:#e0e0e0;border:1px solid #7aa2f7;border-radius:6px;padding:12px;font-family:monospace;font-size:13px;resize:none"></textarea>
    </div>

    <!-- 反馈模式 -->
    <div v-if="mode === 'feedback'" style="flex:1;padding:16px;display:flex;flex-direction:column">
      <label style="font-size:11px;color:#e0af68;margin-bottom:6px">输入反馈意见，将退回给 OC 重新翻译</label>
      <textarea v-model="feedbackText" placeholder="例如：目标不够具体，应该明确是重构还是新增..." style="flex:1;background:#0d0d1a;color:#e0e0e0;border:1px solid #e0af68;border-radius:6px;padding:12px;font-size:14px;resize:none"></textarea>
    </div>

    <!-- 操作栏 -->
    <footer v-if="mode === 'view'" class="actions">
      <button @click="mode='feedback'" data-name="action-feedback" class="btn btn-warn">💬 提意见</button>
      <button @click="mode='edit';editText=rawText" data-name="action-edit" class="btn" style="background:#7aa2f7;color:#1a1b26">✏️ 修改</button>
      <button @click="respond('approve')" data-name="action-approve" class="btn btn-allow">✅ 同意</button>
    </footer>

    <footer v-if="mode === 'edit'" class="actions">
      <button @click="mode='view'" class="btn btn-cancel">取消</button>
      <button @click="respond('edit', editText)" data-name="action-submit-edit" class="btn btn-allow">✅ 提交修改</button>
    </footer>

    <footer v-if="mode === 'feedback'" class="actions">
      <button @click="mode='view'" class="btn btn-cancel">取消</button>
      <button @click="respond('feedback', undefined, feedbackText)" data-name="action-submit-feedback" class="btn btn-warn">💬 提交意见</button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import "../../../../lib/gui-theme.css";
import { ref, computed } from "vue";

const $ = (window as any).__INIT_DATA__;
const initData = !!$;
const rawText = $?.text || "";
const rsp = $?.responseFile || "";
const fs = (window as any).require("fs");

const mode = ref<"view" | "edit" | "feedback">("view");
const editText = ref("");
const feedbackText = ref("");

function parseStructured(text: string) {
  const result: Record<string, string> = { title: "", goal: "", constraints: "", context: "" };
  const m = (re: RegExp) => (text.match(re) || [, ""])[1].trim();
  result.title = m(/\*\*title\*\*:\s*(.+)/i);
  result.goal = m(/\*\*goal\*\*:\s*(.+)/i);
  result.constraints = m(/\*\*constraints\*\*:\s*([\s\S]*?)(?=\*\*user_signals|\*\*context|\*\*$)/i);
  result.context = m(/\*\*context\*\*:\s*([\s\S]*)/i);
  return result;
}

const parsed = computed(() => parseStructured(rawText));
const fields = computed(() => [
  { key: "title", label: "标题", value: parsed.value.title },
  { key: "goal", label: "目标", value: parsed.value.goal },
  { key: "constraints", label: "约束", value: parsed.value.constraints },
  { key: "context", label: "上下文", value: parsed.value.context },
]);

function respond(action: string, text?: string, comment?: string) {
  try {
    fs.writeFileSync(rsp, JSON.stringify({ action, text, comment }));
  } catch (e) {
    console.error("write response failed", e);
  }
  window.close();
}
</script>
