// dimension-weights.js — 分类模型权重表的纯展示逻辑（不依赖 Vue / DOM / Wails）
//
// 输入是 pi 侧算好的 review.dimensions（DimensionReportRow[]），输出是「渲染就绪」的行：
// 数值格式化、条宽百分比、命中标记。放这里而不是 .vue 里，是为了能用 node --test 覆盖，
// 也让「颜色只表示命中与否，不表示风险方向」这个约定有一个可测的落点。

/** 风险值 0-1 → 百分比条宽（0-100） */
export function riskWidth(risk) {
	const v = typeof risk === "number" && Number.isFinite(risk) ? risk : 0;
	return Math.max(0, Math.min(100, v * 100));
}

/** 数值显示：两位小数；缺值显示「—」 */
export function fmt(value) {
	return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

/** 置信度显示：两位小数；undefined 表示该维度没有置信度（noul），显示「无」 */
export function fmtConfidence(confidence) {
	if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "无";
	return confidence.toFixed(2);
}

/** 生效阈值说明：above 一定有；below 为 null 表示该维度不支持 */
export function thresholdLabel(row) {
	const above = fmt(row.above);
	if (row.below === null || row.below === undefined) return `> ${above}`;
	return `> ${above} / < ${fmt(row.below)}`;
}

/**
 * 权重行 → 渲染模型。
 *
 * 约定（提督定的）：颜色只标「这条越线了」，不拿颜色暗示风险方向或大小；
 * 数值本身就是信息，风险高低由数字和条宽表达。
 *
 * disabled 行（本次场景下不启用的维度，如 PTC 下的 scripted_edit）：没问过就没有数值，
 * 不画条也不给数字——0.00 会被读成「问过、无风险」，那不是事实。
 */
export function weightRows(dimensions) {
	if (!Array.isArray(dimensions)) return [];
	return dimensions.map((row, index) => {
		const disabled = row.disabled === true;
		return {
			key: typeof row.id === "string" && row.id ? row.id : `dim-${index}`,
			label: typeof row.label === "string" && row.label ? row.label : row.id || "?",
			type: row.type || "",
			risk: disabled ? "—" : fmt(row.risk),
			riskWidth: disabled ? 0 : riskWidth(row.risk),
			// 只有越线才给强调色；条本身统一用中性色。禁用的维度没问过，谈不上越线
			flagged: !disabled && row.triggered === true,
			confidence: disabled ? "—" : fmtConfidence(row.confidence),
			threshold: thresholdLabel(row),
			raw: disabled ? "" : typeof row.raw === "string" ? row.raw : "",
			reason: typeof row.reason === "string" ? row.reason : "",
			disabled,
			// 行尾说明：没有 note 时也给一句，不让行看起来像坏数据
			disabledNote: disabled
				? typeof row.disabledNote === "string" && row.disabledNote
					? row.disabledNote
					: "本场景不适用"
				: "",
		};
	});
}

/** 命中条数（标题里显示「N 项越线」）：本次没启用的维度不算在里 */
export function flaggedCount(dimensions) {
	if (!Array.isArray(dimensions)) return 0;
	return dimensions.filter((row) => row && row.triggered === true && row.disabled !== true).length;
}
