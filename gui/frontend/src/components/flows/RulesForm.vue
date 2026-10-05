<template>
  <div class="rules">
    <header class="rules-head">
      <span class="rules-title">审核规则表</span>
      <span class="rules-path">{{ path || "…" }}</span>
      <span v-if="dirty" class="rules-dirty">未保存</span>
      <span v-if="msg" class="rules-msg" :class="{ bad }">{{ msg }}</span>
      <span class="rules-spacer" />
      <button class="btn" :disabled="!dirty || saving" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
    </header>

    <p class="rules-hint">
      规则是数据，不是代码：第一条命中的说了算，顺序即优先级。没有规则时判定链照旧按内置那套走；
      动作里的「放行」仍受总开关（档位 auto）管着，绕过不了它。
    </p>

    <div v-if="rules.length === 0" class="rules-empty">还没有规则。</div>

    <ul class="rules-list">
      <li v-for="(rule, index) in rules" :key="index" class="rule">
        <div class="rule-row">
          <input v-model="rule.id" class="w-id" placeholder="id（唯一）" @input="dirty = true" />
          <select v-model="rule.then" class="w-then" @change="dirty = true">
            <option value="allow">放行</option>
            <option value="ask">问人</option>
            <option value="deny">直接拒</option>
          </select>
          <input v-model="rule.note" class="w-note" placeholder="备注：为什么留这条" @input="dirty = true" />
          <button class="btn small" :disabled="index === 0" @click="move(index, -1)">↑</button>
          <button class="btn small" :disabled="index === rules.length - 1" @click="move(index, 1)">↓</button>
          <button class="btn small del" @click="removeRule(index)">删</button>
        </div>
        <div class="rule-cond">
          <span class="cond-label">结论是</span>
          <label v-for="verdict in VERDICTS" :key="verdict" class="chk">
            <input type="checkbox" :checked="(rule.verdict ?? []).includes(verdict)" @change="toggleVerdict(rule, verdict)" />
            {{ verdict }}
          </label>
          <span class="cond-sep">·</span>
          <label class="chk">
            <input type="checkbox" :checked="rule.allTriggeredBelowConfidence !== undefined" @change="toggleThreshold(rule)" />
            触发的维度全没把握（置信度 &lt;
          </label>
          <input v-if="rule.allTriggeredBelowConfidence !== undefined" v-model.number="rule.allTriggeredBelowConfidence" class="w-num" type="number" step="0.05" min="0" max="1" @input="dirty = true" />
          <span v-if="rule.allTriggeredBelowConfidence !== undefined">）</span>
          <label class="chk">
            <input type="checkbox" :checked="rule.noTriggeredDimensions === true" @change="toggleNone(rule)" />
            一个维度都没越线
          </label>
          <input :value="ruleNamesText(rule)" class="w-names" placeholder="命令审计命中（逗号分隔，可选）" @input="setRuleNames(rule, $event.target.value)" />
          <input v-model="rule.commandContains" class="w-cmd" placeholder="命令里含（子串，可选）" @input="dirty = true" />
        </div>
      </li>
    </ul>

    <button class="btn add" @click="addRule">加一条规则</button>
  </div>
</template>
<script setup>
import { onMounted, ref } from "vue";
import { usePlatform } from "../../platform/index.js";

const platform = usePlatform();
const VERDICTS = ["safe", "risky", "dangerous", "error"];

const rules = ref([]);
const path = ref("");
const dirty = ref(false);
const saving = ref(false);
const msg = ref("");
const bad = ref(false);

onMounted(async () => {
  const payload = await platform.rules.get();
  rules.value = payload?.rules ?? [];
  path.value = payload?.path ?? "";
  if (payload?.problems?.length) {
    bad.value = true;
    msg.value = "规则表有校验问题，已整组停用：" + payload.problems.join("；");
  }
});

function toggleVerdict(rule, verdict) {
  const list = rule.verdict ?? [];
  const next = list.includes(verdict) ? list.filter((item) => item !== verdict) : list.concat([verdict]);
  if (next.length === 0) delete rule.verdict;
  else rule.verdict = next;
  dirty.value = true;
}
function toggleThreshold(rule) {
  if (rule.allTriggeredBelowConfidence === undefined) rule.allTriggeredBelowConfidence = 0.5;
  else delete rule.allTriggeredBelowConfidence;
  dirty.value = true;
}
function toggleNone(rule) {
  if (rule.noTriggeredDimensions === true) delete rule.noTriggeredDimensions;
  else rule.noTriggeredDimensions = true;
  dirty.value = true;
}
function ruleNamesText(rule) {
  return (rule.ruleName ?? []).join(", ");
}
function setRuleNames(rule, text) {
  const list = String(text).split(",").map((item) => item.trim()).filter(Boolean);
  if (list.length === 0) delete rule.ruleName;
  else rule.ruleName = list;
  dirty.value = true;
}
function addRule() {
  rules.value.push({ id: "rule-" + (rules.value.length + 1), then: "ask" });
  dirty.value = true;
}
function removeRule(index) {
  rules.value.splice(index, 1);
  dirty.value = true;
}
function move(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= rules.value.length) return;
  const item = rules.value.splice(index, 1)[0];
  rules.value.splice(next, 0, item);
  dirty.value = true;
}
async function save() {
  saving.value = true;
  msg.value = "";
  try {
    const result = await platform.rules.save({ rules: rules.value });
    if (!result?.ok) {
      bad.value = true;
      msg.value = (result?.error ?? "保存失败") + (result?.problems?.length ? "：" + result.problems.join("；") : "");
      return;
    }
    bad.value = false;
    msg.value = "已保存";
    dirty.value = false;
    rules.value = result.rules ?? rules.value;
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.rules { padding: 12px 16px; color: #dfe3ea; font: 12.5px/1.6 system-ui, sans-serif; }
.rules-head { display: flex; align-items: center; gap: 10px; }
.rules-title { font-weight: 600; }
.rules-path { color: #69707d; font-size: 11px; }
.rules-dirty { color: #e6a23c; }
.rules-msg { color: #7bd88f; }
.rules-msg.bad { color: #e6a23c; }
.rules-spacer { flex: 1; }
.rules-hint { color: #69707d; font-size: 11.5px; margin: 6px 0 10px; }
.rules-empty { color: #69707d; padding: 8px 0; }
.rules-list { list-style: none; margin: 0; padding: 0; }
.rule { border: 1px solid #232833; border-radius: 4px; padding: 8px 10px; margin-bottom: 8px; }
.rule-row { display: flex; align-items: center; gap: 8px; }
.rule-cond { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 6px; color: #9aa3b2; }
.cond-label, .cond-sep { color: #69707d; }
.chk { display: inline-flex; align-items: center; gap: 4px; }
input, select { background: #12151c; color: #dfe3ea; border: 1px solid #39414f; border-radius: 3px; padding: 2px 6px; font: inherit; }
.w-id { width: 150px; }
.w-note { flex: 1; min-width: 120px; }
.w-num { width: 68px; }
.w-names, .w-cmd { width: 200px; }
.btn { background: #232c3d; color: #dfe3ea; border: 1px solid #39414f; border-radius: 3px; padding: 3px 10px; cursor: pointer; }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn.small { padding: 1px 7px; }
.btn.del { color: #ff8f8f; }
.btn.add { margin-top: 4px; }
</style>