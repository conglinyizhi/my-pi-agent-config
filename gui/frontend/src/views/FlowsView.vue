<template>
	<div class="flows">
		<aside class="list">
			<header>
				<span>审核流程</span>
				<code class="dir">{{ dir }}</code>
			</header>
			<ul>
				<li
					v-for="item in flows"
					:key="item.id"
					:class="{ active: item.id === selectedId, bad: item.problems.length > 0 }"
					@click="select(item.id)"
				>
					<span class="name">{{ item.id }}</span>
					<span class="badge" :class="item.active">{{ item.active === "authored" ? "自己写的" : "内置" }}</span>
					<span v-if="item.problems.length" class="warn">有问题</span>
				</li>
			</ul>
			<p v-if="flows.length === 0" class="empty">还没有流程文件</p>
		</aside>

		<main class="canvas">
			<div class="canvas-tools">
				<button data-name="toggle-edit" @click="toggleMode">{{ mode === "graph" ? "编辑源码" : "回到图" }}</button>
				<span v-if="dirty" class="dirty">未保存</span>
				<span v-if="saveMsg" class="save-msg" :class="{ bad: saveBad }">{{ saveMsg }}</span>
			</div>
			<VueFlow
				v-if="mode === 'graph'"
				v-model:nodes="nodes"
				v-model:edges="edges"
				@edge-click="onEdgeClick"
				:fit-view-on-init="true"
				:min-zoom="0.3"
				:max-zoom="1.6"
				:default-edge-options="{ type: 'smoothstep' }"
			>
				<template #node-flow="props">
					<div class="node" :class="[props.data.kind, { terminal: props.data.terminal, own: props.data.givesOwnDecision }]">
						<div class="node-top">
							<span class="node-id">{{ props.id }}</span>
							<span class="node-kind">{{ props.data.kindLabel }}</span>
						</div>
						<div v-if="props.data.inputs.length" class="node-io">← {{ props.data.inputs.join("、") }}</div>
						<div v-if="props.data.givesOwnDecision" class="node-own">自己给决定</div>
						<Handle type="target" :position="Position.Left" />
						<Handle type="source" :position="Position.Right" />
					</div>
				</template>
				<Background :gap="18" pattern-color="#2a2f3a" />
				<Controls />
			</VueFlow>
			<div v-else class="editor">
				<textarea v-model="draft" spellcheck="false" data-name="flow-source" @input="dirty = true"></textarea>
				<div class="editor-bar">
					<button data-name="save-flow" :disabled="!dirty || saving || !detail?.source" @click="save">
						{{ saving ? "保存中…" : "保存" }}
					</button>
					<button :disabled="!dirty" @click="revert">还原</button>
					<span class="hint">保存先过越界检查；改完要 /reload 才生效</span>
				</div>
			</div>
			<div v-if="edgeDialog" class="edge-dialog" data-name="edge-dialog">
				<div class="edge-head">
					改边：<code>{{ edgeDialog.nodeId }}</code> 的
					<span class="edge-kind">{{ EDGE_KIND_LABEL[edgeDialog.kind] }}</span>
					<span v-if="edgeDialog.label" class="edge-label">{{ edgeDialog.label }}</span>
				</div>
				<div class="edge-body">
					<span>改到</span>
					<select v-model="edgeDialog.to" data-name="edge-target">
						<option v-for="target in edgeDialog.candidates" :key="target" :value="target">{{ target }}</option>
					</select>
					<button data-name="edge-apply" :disabled="edgeSaving || edgeDialog.to === edgeDialog.from" @click="applyEdge">
						{{ edgeSaving ? "保存中…" : "应用" }}
					</button>
					<button @click="edgeDialog = null">取消</button>
				</div>
				<div v-if="edgeMsg" class="edge-msg" :class="{ bad: edgeBad }">{{ edgeMsg }}</div>
				<p class="edge-hint">只改那一个字面量，别的原样不动；改完要 /reload 才生效</p>
			</div>
			<div v-if="!graph && mode === 'graph'" class="canvas-empty">
				<p>{{ selectedProblem || "选中左边一条流程看它的图" }}</p>
			</div>
		</main>

		<aside class="detail">
			<h3>{{ selectedId || "—" }}</h3>
			<dl>
				<dt>现在跑的是</dt>
				<dd>{{ activeLabel }}</dd>
				<dt>来源</dt>
				<dd><code>{{ selectedSource || "内置" }}</code></dd>
				<dt>节点 / 边</dt>
				<dd>{{ graph ? graph.nodes.length : 0 }} / {{ graph ? graph.edges.length : 0 }}</dd>
			</dl>
			<div v-if="problems.length" class="problems">
				<h4>校验没通过</h4>
				<pre v-for="(text, index) in problems" :key="index">{{ text }}</pre>
			</div>
			<p v-else class="ok">校验通过</p>
			<p class="tip">改完流程要 /reload 才生效。点「编辑源码」改文本，点一条边换目标。</p>
		</aside>
	</div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { Handle, Position, VueFlow } from "@vue-flow/core";
import { layoutGraph } from "../domain/flows/graph-layout.js";
import { usePlatform } from "../platform/index.js";

const platform = usePlatform();
const flows = ref([]);
const dir = ref("");
const selectedId = ref("");
const detail = ref(null);
const nodes = ref([]);
const edges = ref([]);

const KIND_LABEL = {
	chatreview: "对话模型",
	classifier: "分类器",
	merge: "合并",
	autoapprove: "自动放行",
	gate: "人工闸门",
	terminal: "出口",
	custom: "自己的节点",
};

const graph = computed(() => detail.value?.graph ?? null);
const problems = computed(() => detail.value?.problems ?? []);
const selectedSource = computed(() => detail.value?.source ?? "");
const activeLabel = computed(() => (flows.value.find((f) => f.id === selectedId.value)?.active === "authored" ? "你写的那条" : "内置那条"));
const selectedProblem = computed(() => (dir.value === "" ? "" : "这条流程没有图：先看右边的问题"));

const EDGE_KIND_LABEL = { next: "下一步", branch: "分支", error: "出错", timeout: "超时", empty: "拿不准" };

const mode = ref("graph");
const edgeDialog = ref(null);
const edgeSaving = ref(false);
const edgeMsg = ref("");
const edgeBad = ref(false);

/** 点一条边：弹出目标选择。候选是所有节点加两个终端，去掉自己。 */
function onEdgeClick(payload) {
	const edge = payload?.edge;
	if (!edge) return;
	const kind = edge.data?.kind ?? "next";
	const label = kind === "branch" ? String(edge.label ?? "") : "";
	const self = edge.source;
	const candidates = [...new Set([...nodes.value.map((n) => n.id), "allow", "deny"])]
		.filter((id) => id !== self)
		.sort();
	edgeDialog.value = { nodeId: self, kind, label, to: String(edge.target), from: String(edge.target), candidates };
	edgeMsg.value = "";
	edgeBad.value = false;
}

async function applyEdge() {
	const dialog = edgeDialog.value;
	if (!dialog || !selectedId.value) return;
	edgeSaving.value = true;
	edgeMsg.value = "";
	try {
		const result = await platform.flows.editEdge({
			id: selectedId.value,
			nodeId: dialog.nodeId,
			kind: dialog.kind,
			...(dialog.label ? { label: dialog.label } : {}),
			to: dialog.to,
		});
		if (!result?.ok) {
			edgeBad.value = true;
			edgeMsg.value = result?.error ?? "改不动";
			return;
		}
		edgeDialog.value = null;
		const payload = await platform.flows.list();
		flows.value = payload?.flows ?? flows.value;
		await select(selectedId.value);
	} finally {
		edgeSaving.value = false;
	}
}
const draft = ref("");
const dirty = ref(false);
const saving = ref(false);
const saveMsg = ref("");
const saveBad = ref(false);

function toggleMode() {
	mode.value = mode.value === "graph" ? "edit" : "graph";
	if (mode.value === "edit" && !dirty.value) draft.value = detail.value?.sourceText ?? "";
}

function revert() {
	draft.value = detail.value?.sourceText ?? "";
	dirty.value = false;
	saveMsg.value = "";
}

async function save() {
	if (!selectedId.value) return;
	saving.value = true;
	saveMsg.value = "";
	try {
		const result = await platform.flows.save({ id: selectedId.value, content: draft.value });
		if (!result?.ok) {
			saveBad.value = true;
			saveMsg.value = result?.error ?? "保存失败";
			return;
		}
		saveBad.value = (result.problems?.length ?? 0) > 0;
		saveMsg.value = saveBad.value ? "存下来了，但校验没通过（看右边）" : "已保存";
		dirty.value = false;
		const payload = await platform.flows.list();
		flows.value = payload?.flows ?? flows.value;
		await select(selectedId.value);
	} finally {
		saving.value = false;
	}
}

function toFlowNodes(laid) {
	return laid.nodes.map((node) => ({
		id: node.id,
		type: "flow",
		position: { x: node.x, y: node.y },
		sourcePosition: "right",
		targetPosition: "left",
		data: {
			kind: node.kind,
			kindLabel: KIND_LABEL[node.kind] ?? node.kind,
			inputs: node.inputs ?? [],
			givesOwnDecision: node.givesOwnDecision === true,
			terminal: node.terminal ?? "",
		},
	}));
}

function toFlowEdges(laid) {
	return laid.edges.map((edge, index) => ({
		id: `e${index}-${edge.from}-${edge.to}`,
		source: edge.from,
		target: edge.to,
		label: edge.label,
		data: { kind: edge.kind },
	}));
}

async function select(id) {
	selectedId.value = id;
	dirty.value = false;
	saveMsg.value = "";
	const payload = await platform.flows.get(id);
	if (!payload?.ok) {
		detail.value = { problems: [payload?.error ?? "取不到这条流程"] };
		nodes.value = [];
		edges.value = [];
		return;
	}
	detail.value = payload.flow;
	draft.value = payload.flow.sourceText ?? "";
	const laid = payload.flow.graph ? layoutGraph(payload.flow.graph) : null;
	nodes.value = laid ? toFlowNodes(laid) : [];
	edges.value = laid ? toFlowEdges(laid) : [];
}

onMounted(async () => {
	const payload = await platform.flows.list();
	flows.value = payload?.flows ?? [];
	dir.value = payload?.dir ?? "";
	const first = flows.value.find((f) => f.source) ?? flows.value[0];
	if (first) await select(first.id);
	// 告诉启动方"渲染好了"：写 .ready 侧文件。等握手的调用方（含测试）靠它判完成
	await platform.session.markReady();
});
</script>

<style scoped>
.flows { display: flex; height: 100vh; background: #171a21; color: #d7dbe0; font: 13px/1.5 system-ui, sans-serif; }
.list { width: 240px; border-right: 1px solid #262b35; overflow: auto; }
.list header { padding: 12px; border-bottom: 1px solid #262b35; display: flex; flex-direction: column; gap: 4px; }
.list .dir { color: #7c8494; font-size: 11px; word-break: break-all; }
.list ul { list-style: none; margin: 0; padding: 6px; }
.list li { display: flex; align-items: center; gap: 6px; padding: 7px 8px; border-radius: 6px; cursor: pointer; }
.list li:hover { background: #1e2430; }
.list li.active { background: #232c3d; }
.list li.bad .name { color: #e6a23c; }
.list .name { flex: 1; }
.list .badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #2a3140; color: #9aa3b2; }
.list .badge.authored { background: #23402f; color: #7bd88f; }
.list .warn { color: #e6a23c; font-size: 11px; }
.list .empty { color: #69707d; padding: 12px; }
.canvas { flex: 1; position: relative; display: flex; flex-direction: column; }
.canvas-tools { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #262b35; }
/* Vue Flow 的缩放控件默认是浅色，压在深色画布上会剩一块白 */
.canvas :deep(.vue-flow__controls-button) { background: #232c3d; border-bottom: 1px solid #39414f; fill: #d7dbe0; }
.canvas :deep(.vue-flow__controls-button:hover) { background: #2d3646; }
.canvas :deep(.vue-flow__controls) { box-shadow: 0 2px 8px #0006; }
.canvas-tools button { background: #232c3d; color: #d7dbe0; border: 1px solid #39414f; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.canvas-tools button:disabled { opacity: 0.45; cursor: default; }
.dirty { color: #e6a23c; font-size: 12px; }
.save-msg { font-size: 12px; color: #7bd88f; }
.save-msg.bad { color: #e6a23c; }
.editor { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.editor textarea { flex: 1; min-height: 0; resize: none; border: 0; outline: none; background: #12151c; color: #d7dbe0; padding: 12px; font: 12px/1.6 ui-monospace, monospace; tab-size: 2; }
.editor-bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid #262b35; }
.editor-bar button { background: #232c3d; color: #d7dbe0; border: 1px solid #39414f; border-radius: 6px; padding: 4px 12px; cursor: pointer; }
.editor-bar button:disabled { opacity: 0.45; cursor: default; }
.editor-bar .hint { color: #69707d; font-size: 12px; }
.edge-dialog { position: absolute; left: 50%; top: 24px; transform: translateX(-50%); z-index: 5; background: #1f2531; border: 1px solid #39414f; border-radius: 8px; padding: 12px 14px; min-width: 380px; box-shadow: 0 8px 24px #0008; }
.edge-head { margin-bottom: 8px; }
.edge-kind, .edge-label { margin-left: 6px; padding: 1px 6px; border-radius: 8px; background: #2a3140; color: #9aa3b2; font-size: 12px; }
.edge-body { display: flex; align-items: center; gap: 8px; }
.edge-body select { background: #12151c; color: #d7dbe0; border: 1px solid #39414f; border-radius: 6px; padding: 4px 8px; }
.edge-body button { background: #232c3d; color: #d7dbe0; border: 1px solid #39414f; border-radius: 6px; padding: 4px 12px; cursor: pointer; }
.edge-body button:disabled { opacity: 0.45; cursor: default; }
.edge-msg { margin-top: 8px; color: #7bd88f; font-size: 12px; }
.edge-msg.bad { color: #e6a23c; }
.edge-hint { color: #69707d; font-size: 12px; margin: 8px 0 0; }
.canvas-empty { position: absolute; inset: 0; display: grid; place-items: center; color: #69707d; pointer-events: none; }
.detail { width: 300px; border-left: 1px solid #262b35; padding: 12px; overflow: auto; }
.detail h3 { margin: 0 0 10px; }
.detail dl { display: grid; grid-template-columns: 80px 1fr; gap: 4px 8px; margin: 0 0 12px; }
.detail dt { color: #7c8494; }
.detail dd { margin: 0; word-break: break-all; }
.problems pre { white-space: pre-wrap; background: #2a2018; color: #e6a23c; padding: 8px; border-radius: 6px; font-size: 12px; }
.ok { color: #7bd88f; }
.tip { color: #69707d; font-size: 12px; }
.node { background: #1f2531; border: 1px solid #39414f; border-radius: 8px; padding: 8px 10px; min-width: 150px; }
.node.terminal { background: #1d2a22; border-color: #2f5c40; }
.node.gate { border-color: #5c4a2f; }
.node.custom { border-color: #2f4a5c; }
.node-top { display: flex; justify-content: space-between; gap: 8px; }
.node-id { font-weight: 600; }
.node-kind { color: #7c8494; font-size: 11px; }
.node-io { color: #7c8494; font-size: 11px; margin-top: 4px; }
.node-own { color: #e6a23c; font-size: 11px; margin-top: 2px; }
</style>
