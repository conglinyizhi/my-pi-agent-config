// gui/frontend/src/domain/flows/graph-layout.js — 把流程图画出来（纯函数：图 → 坐标）
//
// 只做算术，不碰 DOM：层级决定 x，泳道决定 y，边从右缘连到左缘。
// 这样布局本身能单测，"图长什么样"不藏在组件里。

export const BOX = { width: 176, height: 56, gapX: 104, gapY: 28, padX: 28, padY: 28 };

/** 盒子左缘的 x（按层级） */
export function xOf(rank) {
	return BOX.padX + rank * (BOX.width + BOX.gapX);
}

/** 盒子上缘的 y（按泳道） */
export function yOf(lane) {
	return BOX.padY + lane * (BOX.height + BOX.gapY);
}

/** 一条边的三次贝塞尔：从源盒右缘到目标盒左缘 */
export function edgePath(from, to) {
	const x1 = from.x + BOX.width;
	const y1 = from.y + BOX.height / 2;
	const x2 = to.x;
	const y2 = to.y + BOX.height / 2;
	// 水平间距越大，控制点拉得越远，看着才像"流向"而不是一条弧
	const bend = Math.max(24, (x2 - x1) / 2);
	return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/** 边上的标签位置：起终点中点，稍微抬起来一点，免得压在线上 */
export function labelAt(from, to) {
	return {
		x: (from.x + BOX.width + to.x) / 2,
		y: (from.y + to.y + BOX.height) / 2 - 6,
	};
}

/** 图 → 可直接渲染的坐标与路径 */
export function layoutGraph(graph) {
	const nodes = (graph?.nodes ?? []).map((node) => ({
		...node,
		x: xOf(node.rank ?? 0),
		y: yOf(node.lane ?? 0),
		w: BOX.width,
		h: BOX.height,
	}));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const edges = [];
	for (const edge of graph?.edges ?? []) {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		// 连到不存在的节点就不画：宁缺勿错，别画一条悬空的线
		if (!from || !to) continue;
		const label = labelAt(from, to);
		edges.push({
			...edge,
			d: edgePath(from, to),
			labelX: label.x,
			labelY: label.y,
		});
	}
	const width = Math.max(320, ...nodes.map((node) => node.x + node.w + BOX.padX));
	const height = Math.max(180, ...nodes.map((node) => node.y + node.h + BOX.padY));
	return { nodes, edges, width, height };
}
