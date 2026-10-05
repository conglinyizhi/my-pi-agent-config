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
			<VueFlow
				:sng-nodes="nodes"
				:sng-edges="edges"
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
			<div v-if="!graph" class="canvas-empty">
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
			<p class="tip">改完流程要 /reload 才生效；图只读，编辑下一步做。</p>
		</aside>
	</div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
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
	const payload = await platform.flows.get(id);
	if (!payload?.ok) {
		detail.value = { problems: [payload?.error ?? "取不到这条流程"] };
		nodes.value = [];
		edges.value = [];
		return;
	}
	detail.value = payload.flow;
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
.canvas { flex: 1; position: relative; }
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
