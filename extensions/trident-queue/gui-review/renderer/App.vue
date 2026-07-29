<template>
  <div v-if="!initData" style="color:red;padding:20px">initData 为空</div>
  <div v-else style="display:flex;height:100vh;background:#1a1a2e;color:#e0e0e0">
    <!-- 左侧任务列表 -->
    <div style="width:220px;border-right:1px solid #2a2a4a;display:flex;flex-direction:column;overflow:hidden">
      <header style="padding:10px 14px;border-bottom:1px solid #2a2a4a">
        <h1 style="font-size:14px;color:#7aa2f7;margin:0">⚓ 任务确认</h1>
        <div style="font-size:11px;color:#666;margin-top:2px">{{ texts.length }} 个任务</div>
      </header>
      <div style="flex:1;overflow-y:auto">
        <div v-for="(t, i) in texts" :key="i" @click="select(i)" :style="{
          padding:'10px 14px',cursor:'pointer',borderBottom:'1px solid #1a1a3e',
          background: selectedIdx===i ? '#1a2a4a' : 'transparent',
          borderLeft: selectedIdx===i ? '3px solid #7aa2f7' : '3px solid transparent'
        }">
          <div style="display:flex;align-items:center;gap:6px">
            <span :style="{fontSize:'13px',color:statusColor(states[i].status)}">{{ statusIcon(states[i].status) }}</span>
            <span style="font-size:12px;font-weight:500;word-break:break-word;line-height:1.3">{{ previewTitle(i) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 右侧详情 -->
    <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
      <template v-if="selectedIdx !== null">
        <header style="padding:8px 16px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:#7aa2f7;font-weight:600">任务 {{ selectedIdx + 1 }} / {{ texts.length }}</span>
          <span v-if="texts.length>1" style="font-size:11px;color:#666">◀▶ 点击左侧切换</span>
        </header>

        <!-- 查看模式 -->
        <div v-if="mode==='view'" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px">
          <div v-for="f in fields" :key="f.key" style="display:flex;flex-direction:column">
            <label style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">{{ f.label }}</label>
            <pre style="background:#0d0d1a;padding:10px 14px;border-radius:6px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0;min-height:24px">{{ f.value || '(未识别)' }}</pre>
          </div>
        </div>

        <!-- 编辑模式 -->
        <div v-if="mode==='edit'" style="flex:1;padding:16px;display:flex;flex-direction:column">
          <label style="font-size:11px;color:#e0af68;margin-bottom:6px">编辑任务 {{ selectedIdx+1 }} 的描述（保持格式）</label>
          <textarea v-model="editText" style="flex:1;background:#0d0d1a;color:#e0e0e0;border:1px solid #7aa2f7;border-radius:6px;padding:12px;font-family:monospace;font-size:13px;resize:none"></textarea>
        </div>
      </template>
      <div v-else style="flex:1;display:flex;align-items:center;justify-content:center;color:#565f89;font-size:14px">
        选择左侧任务查看详情
      </div>

      <!-- 操作栏 -->
      <footer v-if="selectedIdx !== null && mode==='view'" class="actions">
        <button @click="setState('feedback')" data-name="action-feedback" class="btn btn-warn">💬 退回重译</button>
        <button @click="mode='edit';editText=texts[selectedIdx!]" data-name="action-edit" class="btn" style="background:#7aa2f7;color:#1a1b26">✏️ 修改</button>
        <button @click="setState('approved')" data-name="action-approve" class="btn btn-allow">✅ 通过</button>
      </footer>

      <footer v-if="selectedIdx !== null && mode==='edit'" class="actions">
        <button @click="mode='view'" class="btn btn-cancel">取消</button>
        <button @click="submitEdit" data-name="action-submit-edit" class="btn btn-allow">✅ 提交修改</button>
      </footer>

      <!-- 底栏：全部确认 -->
      <footer v-if="allReviewed" style="padding:12px 16px;border-top:1px solid #2a2a4a">
        <button @click="approveAll" data-name="action-approve-all" class="btn btn-allow" style="width:100%;padding:14px;font-size:15px">
          ✅ 全部确认（{{ approvedCount }}/{{ texts.length }}）
        </button>
      </footer>
      <footer v-else style="padding:12px 16px;border-top:1px solid #2a2a4a">
        <div style="text-align:center;font-size:12px;color:#565f89">
          审核进度：{{ approvedCount }}/{{ texts.length }}
        </div>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import "../../../../lib/gui-theme.css";
import { ref, computed, reactive } from "vue";

const $ = (window as any).__INIT_DATA__;
const initData = !!$;
const texts: string[] = $?.texts || [];
const rsp = $?.responseFile || "";
const fs = (window as any).require("fs");

const selectedIdx = ref<number | null>(texts.length > 0 ? 0 : null);
const mode = ref<"view" | "edit">("view");
const editText = ref("");

interface TaskState { status: "pending" | "approved" | "feedback"; comment: string; editedText: string }
const states = reactive<TaskState[]>(texts.map(() => ({ status: "pending", comment: "", editedText: "" })));

const approvedCount = computed(() => states.filter(s => s.status === "approved").length);
const allReviewed = computed(() => states.every(s => s.status !== "pending"));

function select(i: number) {
  selectedIdx.value = i;
  mode.value = "view";
}

function setState(s: TaskState["status"]) {
  if (selectedIdx.value === null) return;
  if (s === "feedback") {
    const comment = prompt("退回理由（可为空）：");
    if (comment === null) return; // 取消
    states[selectedIdx.value].status = "feedback";
    states[selectedIdx.value].comment = comment || "未说明";
  } else {
    states[selectedIdx.value].status = s;
  }
}

function submitEdit() {
  if (selectedIdx.value === null) return;
  states[selectedIdx.value].editedText = editText.value;
  states[selectedIdx.value].status = "approved";
  mode.value = "view";
}

function approveAll() {
  const finalTexts = texts.map((t, i) => states[i].editedText || t);
  const feedbacks = states
    .map((s, i) => s.status === "feedback" ? { index: i, comment: s.comment } : null)
    .filter(Boolean) as Array<{ index: number; comment: string }>;

  try {
    fs.writeFileSync(rsp, JSON.stringify({
      action: "approve",
      texts: finalTexts,
      feedbacks: feedbacks.length > 0 ? feedbacks : undefined,
    }));
  } catch (e) {
    console.error("write response failed", e);
  }
  window.close();
}

function previewTitle(i: number): string {
  const m = texts[i].match(/\*\*title\*\*:\s*(.+)/i);
  return m?.[1]?.trim() || `任务 ${i + 1}`;
}

function parseStructured(text: string) {
  const result: Record<string, string> = { title: "", goal: "", constraints: "", context: "" };
  const m = (re: RegExp) => (text.match(re) || [, ""])[1].trim();
  result.title = m(/\*\*title\*\*:\s*(.+)/i);
  result.goal = m(/\*\*goal\*\*:\s*(.+)/i);
  result.constraints = m(/\*\*constraints\*\*:\s*([\s\S]*?)(?=\*\*user_signals|\*\*context|\*\*$)/i);
  result.context = m(/\*\*context\*\*:\s*([\s\S]*)/i);
  return result;
}

const parsed = computed(() => selectedIdx.value !== null ? parseStructured(texts[selectedIdx.value]) : null);
const fields = computed(() => parsed.value ? [
  { key: "title", label: "标题", value: parsed.value.title },
  { key: "goal", label: "目标", value: parsed.value.goal },
  { key: "constraints", label: "约束", value: parsed.value.constraints },
  { key: "context", label: "上下文", value: parsed.value.context },
] : []);

function statusIcon(s: string) {
  return s === "approved" ? "✅" : s === "feedback" ? "↩" : "○";
}

function statusColor(s: string) {
  return s === "approved" ? "#9ece6a" : s === "feedback" ? "#e0af68" : "#565f89";
}
</script>
