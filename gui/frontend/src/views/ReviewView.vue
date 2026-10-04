<template>
  <div v-if="ready" class="app" @keydown.escape="close">
    <header class="header">
      <span class="title">审核工作流设置</span>
      <div class="header-right">
        <span class="hint">存盘即生效：下一次审核就按新值走，不用 reload</span>
        <button class="btn btn-cancel btn-small" data-name="review-close" @click="close">关闭</button>
      </div>
    </header>

    <div class="body">
      <!-- 读文件时的降级提示 / 上次操作结果 -->
      <div v-if="warnings.length" class="banner banner-warn" data-name="review-warnings">
        <div v-for="(w, i) in warnings" :key="i">⚠ {{ w }}</div>
      </div>
      <div v-if="errors.length" class="banner banner-error" data-name="review-errors">
        <div v-for="(e, i) in errors" :key="i">✕ {{ e }}</div>
      </div>
      <div v-if="status" class="banner banner-ok" data-name="review-status">{{ status }}</div>

      <!-- 总开关 / 档位 / 后端 -->
      <section class="card">
        <h2>总开关与档位</h2>
        <div class="row">
          <label class="field field-check">
            <input v-model="form.llm.enabled" type="checkbox" data-name="review-enabled">
            <span>启用 LLM 预审（总开关）</span>
          </label>
          <span class="note">关掉后 gate 完全跳过预审，回到纯弹窗流程</span>
        </div>
        <div class="row">
          <span class="field-label">档位</span>
          <label class="field field-radio">
            <input v-model="form.llm.mode" type="radio" value="auto" data-name="review-mode-auto">
            <span>auto：判安全直接放行（弹窗最少）</span>
          </label>
          <label class="field field-radio">
            <input v-model="form.llm.mode" type="radio" value="strict" data-name="review-mode-strict">
            <span>strict：只给意见，仍然弹窗</span>
          </label>
        </div>
        <div class="row">
          <span class="field-label">审核后端</span>
          <select v-model="form.llm.backend" class="input select" data-name="review-backend">
            <option v-for="b in backends" :key="b" :value="b">{{ backendLabel(b) }}</option>
          </select>
        </div>
      </section>

      <!-- 超时与缓存 -->
      <section class="card">
        <h2>超时与缓存</h2>
        <div class="grid">
          <label class="field">
            <span>审核总时长兜底（毫秒）</span>
            <input v-model="form.llm.timeoutMs" type="number" class="input" data-name="review-timeout-ms">
          </label>
          <label class="field">
            <span>相邻 token 间隔上限（毫秒）</span>
            <input v-model="form.llm.tokenIdleMs" type="number" class="input" data-name="review-token-idle-ms">
          </label>
          <label class="field">
            <span>内存缓存上限（条）</span>
            <input v-model="form.llm.maxCache" type="number" class="input" data-name="review-max-cache">
          </label>
          <label class="field">
            <span>分类器超时（毫秒）</span>
            <input v-model="form.classifier.timeoutMs" type="number" class="input" data-name="review-classifier-timeout-ms">
          </label>
        </div>
        <div class="note">
          允许范围：审核总时长 {{ limits.timeoutMsMin }}–{{ limits.timeoutMsMax }} ·
          token 间隔 {{ limits.tokenIdleMsMin }}–{{ limits.tokenIdleMsMax }} ·
          缓存 {{ limits.maxCacheMin }}–{{ limits.maxCacheMax }} ·
          分类器超时 {{ limits.classifierTimeoutMsMin }}–{{ limits.classifierTimeoutMsMax }}
        </div>
      </section>

      <!-- 分类器端点与模型 -->
      <section class="card">
        <h2>分类模型（endpoint / model）</h2>
        <div class="grid">
          <label class="field field-wide">
            <span>端点 base_url（必须 http(s)）</span>
            <input v-model="form.classifier.baseUrl" type="text" class="input" data-name="review-base-url">
          </label>
          <label class="field">
            <span>模型 model</span>
            <input v-model="form.classifier.model" type="text" class="input" data-name="review-model">
          </label>
        </div>
        <div class="note" data-name="review-key-status">
          API key：{{ keyConfigured ? "已配置" : "未配置" }}（key 不入界面，用 <code>/sandbox:gui key</code> 录入）
          · 维度阈值写在 <code>{{ dimensionsPath }}</code>
        </div>
      </section>

      <!-- 八个维度 -->
      <section class="card">
        <h2>维度阈值（{{ rows.length }} 维）</h2>
        <div class="note">
          above = 风险值高于它 → 提示过目 · below = 置信度低于它 → 提示过目（noul 无置信度，显示「不适用」）
          · 动作只有 提示 / 忽略，没有 block
        </div>
        <table class="dims">
          <thead>
            <tr>
              <th>启用</th>
              <th>维度</th>
              <th>above</th>
              <th>below</th>
              <th>动作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id" :class="{ off: !row.enabled }">
              <td>
                <input
                  v-model="row.enabled"
                  type="checkbox"
                  :data-name="`review-dim-enabled-${row.id}`"
                >
              </td>
              <td class="dim-name">
                <div>{{ row.label }}</div>
                <div class="dim-meta">{{ row.id }} · {{ row.type }}</div>
              </td>
              <td class="num">
                <button class="step" :data-name="`review-dim-above-down-${row.id}`" @click="step(row, 'above', -1)">−</button>
                <input v-model="row.above" type="number" step="0.05" class="input input-num" :data-name="`review-dim-above-${row.id}`">
                <button class="step" :data-name="`review-dim-above-up-${row.id}`" @click="step(row, 'above', 1)">+</button>
              </td>
              <td class="num">
                <template v-if="row.supportsBelow">
                  <button class="step" :data-name="`review-dim-below-down-${row.id}`" @click="step(row, 'below', -1)">−</button>
                  <input v-model="row.below" type="number" step="0.05" class="input input-num" :data-name="`review-dim-below-${row.id}`">
                  <button class="step" :data-name="`review-dim-below-up-${row.id}`" @click="step(row, 'below', 1)">+</button>
                </template>
                <span v-else class="dim-meta" data-name="review-dim-below-na">不适用</span>
              </td>
              <td>
                <select v-model="row.action" class="input select" :data-name="`review-dim-action-${row.id}`">
                  <option value="review">提示</option>
                  <option value="ignore">忽略</option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <footer class="footer">
      <span class="footer-note">{{ footerNote }}</span>
      <div class="footer-buttons">
        <button class="btn btn-cancel" :disabled="busy" data-name="review-reload" @click="reload">重新载入</button>
        <button class="btn btn-primary" :disabled="busy" data-name="review-save" @click="save">
          {{ busy ? "处理中…" : "保存（立即生效）" }}
        </button>
      </div>
    </footer>
  </div>
</template>

<script setup>
import "../gui-theme.css";
import { computed, onMounted, ref } from "vue";
import { usePlatform } from "../platform/index.js";
import {
  BACKENDS,
  dimensionRows,
  errorLines,
  formFromSettings,
  limitsOf,
  patchFromForm,
  stepValue,
  summarizeChanges,
  validateForm,
} from "../domain/review/settings.js";

const platform = usePlatform();

const ready = ref(false);
const busy = ref(false);
const form = ref(formFromSettings({}));
const specs = ref([]);
const limits = ref(limitsOf(null));
const paths = ref({});
const keyConfigured = ref(false);
const warnings = ref([]);
const errors = ref([]);
const status = ref("");

const rows = ref([]);
const backends = BACKENDS;
const dimensionsPath = computed(() => displayPath(paths.value.dimensionsToml));
const footerNote = computed(() =>
  errors.value.length ? `${errors.value.length} 个字段不合法，没有落盘` : "值不合法会被拒绝，文件不会被改动"
);

function displayPath(path) {
  if (typeof path !== "string" || !path) return "review-dimensions.toml";
  return path.replace(/^.*sandbox-permissions\//, "extensions/sandbox-permissions/");
}

function applyPayload(data) {
  if (data?.settings) form.value = formFromSettings(data.settings);
  if (Array.isArray(data?.specs) && data.specs.length) specs.value = data.specs;
  if (data?.limits) limits.value = limitsOf(data.limits);
  if (data?.paths) paths.value = data.paths;
  if (data?.settings?.warnings) warnings.value = data.settings.warnings;
  // 行对象就是 form.dimensions 里那几个（就地在上面挂展示字段），v-model 才写得回表单
  rows.value = dimensionRows(form.value, specs.value);
}

function backendLabel(backend) {
  if (backend === "chat") return "chat：只跑对话模型";
  if (backend === "classifier") return "classifier：只跑分类模型";
  return "chain：两边都跑，意见合并（任一判风险就弹窗）";
}

function step(row, key, direction) {
  const delta = limits.value.step * direction;
  const current = row[key] ?? limits.value.aboveMin;
  const next = stepValue(current, delta, limits.value);
  // 阈值区间对 above / below 是同一对边界（与后端 REVIEW_LIMITS 一致）
  row[key] = next;
  errors.value = [];
  status.value = "";
}

async function reload() {
  busy.value = true;
  errors.value = [];
  status.value = "";
  try {
    const res = await platform.review.load();
    if (res?.ok) {
      applyPayload(res);
      warnings.value = res.settings?.warnings || [];
      status.value = "已重新载入当前配置";
    } else {
      errors.value = errorLines(res);
    }
  } catch (err) {
    errors.value = [`重新载入失败：${err?.message || err}`];
  } finally {
    busy.value = false;
  }
}

async function save() {
  errors.value = [];
  status.value = "";
  const local = validateForm(form.value, limits.value);
  if (local.length) {
    errors.value = local;
    return;
  }
  busy.value = true;
  try {
    const res = await platform.review.save(patchFromForm(form.value));
    if (res?.ok) {
      applyPayload(res);
      warnings.value = res.settings?.warnings || [];
      status.value = summarizeChanges(res.changed);
    } else {
      errors.value = errorLines(res);
    }
  } catch (err) {
    errors.value = [`保存失败：${err?.message || err}`];
  } finally {
    busy.value = false;
  }
}

async function close() {
  await platform.session.close();
}

onMounted(async () => {
  // 首屏优先用 initData 里的快照（不发 IO），拿不到再走一次 load
  const data = await platform.session.getInitData();
  if (data?.settings) {
    applyPayload(data);
    if (typeof data.keyConfigured === "boolean") keyConfigured.value = data.keyConfigured;
  } else {
    await reload();
  }
  ready.value = true;
  await platform.session.markReady();
});
</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
}

.header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.title { font-size: 14px; font-weight: 600; color: var(--accent); }
.header-right { display: flex; gap: 10px; align-items: center; }
.hint { font-size: 11px; color: var(--text-muted); }

.body { flex: 1; overflow-y: auto; padding: 12px 16px; }

.banner { padding: 8px 12px; border-radius: var(--radius); font-size: 12px; margin-bottom: 10px; white-space: pre-wrap; }
.banner-warn { background: var(--warn-bg); color: var(--warn); }
.banner-error { background: var(--danger-bg); color: var(--danger); }
.banner-ok { background: #2ecc7122; color: var(--success); }

.card {
  background: var(--bg-alt); border: 1px solid var(--border); border-radius: 6px;
  padding: 12px 14px; margin-bottom: 12px;
}
.card h2 { font-size: 13px; color: var(--accent); margin: 0 0 10px; font-weight: 600; }

.row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.row:last-child { margin-bottom: 0; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim); }
.field-wide { grid-column: 1 / -1; }
.field-check, .field-radio { flex-direction: row; align-items: center; gap: 6px; color: var(--text); }
.field-label { font-size: 12px; color: var(--text-dim); min-width: 72px; }
.note { font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.6; }
.note code { color: var(--code-fg); }

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }

.input {
  background: var(--bg); border: 1px solid var(--border); border-radius: 3px;
  color: var(--text); padding: 5px 8px; font-size: 12px; font-family: var(--mono);
}
.input:focus { outline: 1px solid var(--accent); }
.select { font-family: var(--font); }
.input-num { width: 78px; text-align: right; }

.dims { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
.dims th {
  text-align: left; font-weight: 500; color: var(--text-muted); font-size: 11px;
  padding: 4px 6px; border-bottom: 1px solid var(--border);
}
.dims td { padding: 4px 6px; border-bottom: 1px solid #1f1f3a; vertical-align: middle; }
.dims tr.off td { color: var(--text-muted); }
.dim-name { color: var(--text); }
.dim-meta { font-size: 10px; color: var(--text-muted); font-family: var(--mono); }
.num { white-space: nowrap; }
.step {
  background: var(--bg-hover); border: 1px solid var(--border); color: var(--text-dim);
  border-radius: 3px; width: 22px; height: 22px; cursor: pointer; font-family: var(--mono);
}
.step:hover { background: var(--bg-active); color: var(--text); }

.footer {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding: 10px 16px; border-top: 1px solid var(--border); flex-shrink: 0;
}
.footer-note { font-size: 11px; color: var(--text-muted); }
.footer-buttons { display: flex; gap: 8px; }
.btn:disabled { opacity: 0.55; cursor: default; }
</style>
