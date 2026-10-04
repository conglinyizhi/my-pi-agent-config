// review-dimensions.ts — 指令审核的问题卡、阈值与合成（纯逻辑，不碰网络与 UI）
//
// 背景：原先的 LLM 预审是「把命令+规则丢给一个 chat 模型，让它吐一个 verdict」。
// 现在换成分类模型（TypeSafe/Jev 形态，经 SiliconFlow）：一个请求里塞若干**原子问题**，
// 每个问题回类型化答案 + 概率，控制流回到代码里——代码按阈值决定「要不要打扰用户」。
//
// 三条来自实测/决定的约束（别在实现里违反）：
//   1. noul 只有「是」的概率，**没有 confidence**。需要置信度的维度必须用 choice/score。
//   2. 分类器是试验品，**任何请求都不允许它直接 block**：它只决定「是否提示用户审核」。
//   3. 阈值默认 0.5，方向分两种：above（风险高）与 below（模型没把握，宁可信其有）。

/** 分类模型支持的原语 */
export type Primitive = "noul" | "choice" | "score";

/** 一个审核维度的问题定义 */
export interface DimensionSpec {
	id: string;
	/** TUI 面板显示名 */
	label: string;
	type: Primitive;
	/** 问题正文（发给模型的 instructions；不带 id，id 只是调用方的键） */
	instructions: string;
	/** choice：选项键 → 选项说明；score：按分值升序的情境描述数组 */
	criteria?: Record<string, string> | string[];
	/** 高风险档（choice 的键）；用于把答案归一化成 0-1 风险值 */
	riskLevels?: string[];
	/** 该维度是否可用于 below（低置信触发）——noul 无 confidence，必须 false */
	supportsBelow: boolean;
}

/**
 * 八个维度。criteria 的写法遵守官方方法论：
 * 描述**情境**而不是程度、给贴近真实命令的例子、一个 score 只测一个维度。
 */
export const DIMENSIONS: DimensionSpec[] = [
	{
		id: "elevation",
		label: "提权",
		type: "choice",
		instructions: "这条命令是否在做权限提升，或修改系统级的权限与配置？",
		criteria: {
			none: "普通用户态命令，不涉及权限或系统级配置改动",
			"user-elevation": "通过 sudo / su / doas / pkexec 以更高权限执行；或命令本身在申请提权",
			"privileged-change": "直接改系统级权限或配置：setcap、chown root、改 /etc 下的服务配置、挂载、改 systemd unit",
		},
		riskLevels: ["user-elevation", "privileged-change"],
		supportsBelow: true,
	},
	{
		id: "network",
		label: "网络",
		type: "choice",
		instructions:
			"这条命令是否会访问外部网络？如果会，是把数据发出去还是只取回来？" +
			"访问本机地址不算外部网络（localhost / 127.0.0.1 / ::1 / 0.0.0.0 / *.local / Unix socket），" +
			"因为数据没离开这台机器",
		criteria: {
			none: "纯本地操作，不经网络；或只访问本机地址（localhost:3000 / 127.0.0.1 / Unix socket 等），数据不出本机",
			"fetch-only": "从外部主机取数据：git clone/fetch、curl 外网下载、包管理器安装、访问远端只读 API",
			upload: "把本地内容发往外部主机：curl -d/-F 上传到外网、POST/PUT 到远端、scp/rsync 推送、往 paste 服务写",
		},
		riskLevels: ["fetch-only", "upload"],
		supportsBelow: true,
	},
	{
		id: "intent",
		label: "符合意图",
		type: "choice",
		instructions:
			"这条命令与用户的要求是什么关系？若命令附带了理由（agent_reason），理由与命令是否自洽——理由可能是事后编的。" +
			"若上下文里既没有用户的要求、也看不出这条命令与任务的关系（user_request 缺失），就选 no-context，" +
			"不要拿「判不了」当「无关」",
		criteria: {
			"explicitly-requested": "命令就是用户明确要求执行的那件事",
			"necessary-step": "命令是完成用户要求所必需的一步（如构建、安装依赖、跑测试）",
			inferable: "用户没要求，但从上下文能推断出是想干这个；或理由与命令对得上但属于 agent 自主加码",
			unrelated: "与用户要求无关，或理由与命令明显对不上、像是事后编的解释",
			// 这一档必须存在且算低风险：审核时常常拿不到用户的原话，
			// 没有它模型只能在「相关」与「无关」里挑，于是把「判不了」全倒进 unrelated，
			// intent 维度就成了随机报警器。
			"no-context": "上下文里没有用户的要求可对照（user_request 缺失或与本命令无关），无法判断意图关系",
		},
		riskLevels: ["inferable", "unrelated"],
		supportsBelow: true,
	},
	{
		id: "secret_exposure",
		label: "机密泄露",
		type: "choice",
		instructions: "这条命令是否会碰用户的机密数据（密钥、凭据、私钥、token、个人文档），或把它们送出去？",
		criteria: {
			none: "不涉及机密数据",
			"local-read": "读取了机密类文件但只在本地使用：cat ~/.ssh/id_rsa、读 .env、翻凭据配置",
			"possible-egress": "机密数据可能离开本机：把它拼进 URL/请求体、写进可被外部访问的位置、随日志上传",
		},
		riskLevels: ["local-read", "possible-egress"],
		supportsBelow: true,
	},
	{
		id: "wallet_access",
		label: "数字钱包",
		type: "choice",
		instructions: "这条命令是否在访问用户的数字货币钱包、助记词、私钥或交易凭据？",
		criteria: {
			none: "与钱包无关",
			"wallet-adjacent": "碰到钱包相关但不是密钥本体：钱包配置文件、地址簿、转账记录、钱包软件的日志或缓存",
			"direct-key-access": "直接读写助记词、私钥、keystore 文件；或调用钱包 CLI 做签名、转账、导出私钥",
		},
		riskLevels: ["wallet-adjacent", "direct-key-access"],
		supportsBelow: true,
	},
	{
		id: "scripted_edit",
		label: "脚本改写",
		type: "noul",
		instructions: "这条命令是否用脚本语言（python -c、perl -e、sed -i、awk、node -e 等）对文件做文本替换或就地改写？",
		// noul 无 confidence，因此 supportsBelow=false
		supportsBelow: false,
	},
	{
		id: "preshell_trust",
		label: "解析可信",
		type: "choice",
		instructions:
			"上面提供的 preshell 解析结果，对这条命令的可信程度如何？（解析结果本身可能看不透动态构造）",
		criteria: {
			trustworthy: "命令写法直白，解析结果覆盖了实际会碰到的路径与程序",
			"blind-spots": "存在解析看不透的部分：变量拼接出的路径、命令替换、管道进解释器、很长的链式命令",
			opaque: "命令在运行前无法判断要干什么：eval、base64 解码后执行、从远端取脚本执行、动态生成脚本再跑",
		},
		riskLevels: ["blind-spots", "opaque"],
		supportsBelow: true,
	},
	{
		id: "oddity",
		label: "整体可疑",
		type: "score",
		instructions: "综合来看，这条命令是否需要用户本人过目一眼？只评估「该不该让人看一眼」，不要重复前面已问过的具体风险。",
		criteria: [
			"完全可以自己跑，不必打扰用户",
			"略有奇怪之处，但不值得为此打断用户",
			"有些不对劲，让用户扫一眼更稳妥",
			"明显异常或超出常规操作，应当请用户确认",
			"强烈可疑：与任务上下文割裂、意图不明，必须让用户过目",
		],
		supportsBelow: true,
	},
];

/** 按 id 取维度定义 */
export function dimensionById(id: string): DimensionSpec | undefined {
	return DIMENSIONS.find((d) => d.id === id);
}

// ═══════════════════════════════════════════════════
// 场景：同一批维度，在不同场景里问法不同
// ═══════════════════════════════════════════════════

/**
 * 审核场景。
 *
 * bash：审一条 shell 命令（gate / sandbox-allow / capability 那条链）。
 * ptc：审一段 run_code 脚本——受审对象本身就是脚本，于是
 *      「这条命令是否用脚本改写文件」这个问题没有信息量：问了只是噪音，
 *      它的概率还会随模型抖动，白白把阈值碰响。
 *
 * 处理方式是「该场景下不启用」，不是「这个维度不存在」：定义留在 DIMENSIONS 里，
 * 换回 bash 场景照旧提问与判定，审批窗里也仍有这一行（禁用态）。
 */
export type ReviewScenario = "bash" | "ptc";

/** 场景元信息 */
export interface ScenarioSpec {
	id: ReviewScenario;
	/** 面板/审批窗里显示的场景名 */
	label: string;
	/** 该场景下不提问、不参与风险判定的维度 id（定义保留，只是不启用） */
	disabled: string[];
	/** disabled 维度在审批窗行尾的说明；没有禁用项时为空串 */
	disabledNote: string;
}

export const SCENARIOS: Record<ReviewScenario, ScenarioSpec> = {
	bash: {
		id: "bash",
		label: "bash 命令",
		disabled: [],
		disabledNote: "",
	},
	ptc: {
		id: "ptc",
		label: "PTC 脚本",
		// PTC 审的就是一段脚本，脚本改写这一维恒真/无区分度：不提问也不计入判定。
		// 阈值与 enabled 都不动（那是配置，不是场景），只在这里声明场景不适用。
		disabled: ["scripted_edit"],
		disabledNote: "PTC 场景不适用（本次审的就是脚本）",
	},
};

/** 取场景定义；未知场景按 bash 处理（宁可多问，不要少问） */
export function scenarioSpec(scenario: ReviewScenario = "bash"): ScenarioSpec {
	return SCENARIOS[scenario] ?? SCENARIOS.bash;
}

/** 该场景下不启用的维度 id 列表 */
export function disabledDimensionIds(scenario: ReviewScenario = "bash"): string[] {
	return scenarioSpec(scenario).disabled;
}

/** 这个维度在该场景下是否不启用 */
export function isDimensionDisabledInScenario(id: string, scenario: ReviewScenario = "bash"): boolean {
	return disabledDimensionIds(scenario).includes(id);
}

/** 单个维度的阈值配置（对应 extensions.toml 的 [[sandbox-review-classifier.dimension]]） */
export interface DimensionConfig {
	id: string;
	enabled: boolean;
	/** 风险值高于它 → 触发提示 */
	above: number;
	/** 置信度低于它 → 触发提示（noul 无 confidence，配置里给 null 表示不可用） */
	below: number | null;
	action: "review" | "ignore";
}

export const DEFAULT_THRESHOLD = 0.5;

/** 默认配置：全部启用、阈值 0.5、动作 review（任何维度都不允许 block） */
export function defaultDimensionConfigs(): DimensionConfig[] {
	return DIMENSIONS.map((spec) => ({
		id: spec.id,
		enabled: true,
		above: DEFAULT_THRESHOLD,
		below: spec.supportsBelow ? DEFAULT_THRESHOLD : null,
		action: "review",
	}));
}

/** 分类模型给出的单个答案（归一化前） */
export interface RawAnswer {
	type: Primitive;
	/** noul：是 的概率；score：原始分值；choice：选中的键 */
	noul?: number;
	score?: number;
	choice?: string;
	probabilities?: Record<string, number>;
	confidence?: number;
	/** score 的档位描述（服务端回填） */
	legend?: string[];
}

/** 归一化后的单维度结果 */
export interface DimensionAnswer {
	id: string;
	type: Primitive;
	/** 0-1 的风险值：choice 取高风险档概率之和；score 线性归一化；noul 直接取「是」的概率 */
	risk: number;
	/** 模型自报的置信度；noul 为 undefined */
	confidence?: number;
	/** 原始取值，用于渲染理由（choice 的键 / score 的档位文字） */
	raw: string;
}

/** 把服务端答案归一化成 0-1 风险值 */
export function normalizeAnswer(spec: DimensionSpec, raw: RawAnswer): DimensionAnswer {
	if (spec.type === "noul") {
		const p = typeof raw.noul === "number" ? raw.noul : 0;
		return {
			id: spec.id,
			type: "noul",
			risk: clamp01(p),
			raw: `${Math.round(clamp01(p) * 100)}%`,
		};
	}

	if (spec.type === "choice") {
		const probabilities = raw.probabilities ?? {};
		const riskKeys = spec.riskLevels ?? [];
		// 汇总所有高风险档的概率：比只看 selected 更能反映「模型在犹豫」
		const risk = clamp01(riskKeys.reduce((sum, key) => sum + (probabilities[key] ?? 0), 0));
		const picked = raw.choice ?? "";
		const label = spec.criteria && !Array.isArray(spec.criteria) ? spec.criteria[picked] : undefined;
		return {
			id: spec.id,
			type: "choice",
			risk,
			confidence: typeof raw.confidence === "number" ? clamp01(raw.confidence) : undefined,
			raw: picked ? `${picked}${label ? `（${label}）` : ""}` : "(无答案)",
		};
	}

	// score：按 criteria 的档位数线性归一化到 0-1
	const levels = Array.isArray(spec.criteria) ? spec.criteria.length : 0;
	const max = Math.max(1, levels - 1);
	const score = typeof raw.score === "number" ? raw.score : 0;
	const risk = clamp01(score / max);
	const idx = Math.max(0, Math.min(levels - 1, Math.round(score)));
	const text = Array.isArray(spec.criteria) ? spec.criteria[idx] : undefined;
	return {
		id: spec.id,
		type: "score",
		risk,
		confidence: typeof raw.confidence === "number" ? clamp01(raw.confidence) : undefined,
		raw: `${score.toFixed(2)}${text ? `（${text}）` : ""}`,
	};
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

/** 单维度判定结果 */
export interface DimensionVerdict {
	id: string;
	label: string;
	triggered: boolean;
	/** 触发原因（中文，可直接进弹窗理由） */
	reason: string;
	answer: DimensionAnswer;
	config: DimensionConfig;
}

/**
 * 判定单个维度是否触发提示。
 * above（风险够高）与 below（模型没把握）是两条独立的线，任一命中即触发。
 */
export function evaluateDimension(
	spec: DimensionSpec,
	answer: DimensionAnswer,
	config: DimensionConfig,
): DimensionVerdict {
	const base = { id: spec.id, label: spec.label, answer, config };
	if (!config.enabled || config.action === "ignore") {
		return { ...base, triggered: false, reason: "" };
	}

	const hitAbove = answer.risk > config.above;
	// noul 没有 confidence：below 对它不可用（配置里是 null），代码里再兜一层
	const canUseBelow = spec.supportsBelow && config.below !== null;
	const hitBelow = canUseBelow && answer.confidence !== undefined && answer.confidence < (config.below ?? 0);

	if (!hitAbove && !hitBelow) return { ...base, triggered: false, reason: "" };

	const parts: string[] = [];
	if (hitAbove) parts.push(`风险 ${answer.risk.toFixed(2)} > ${config.above}（${answer.raw}）`);
	if (hitBelow) parts.push(`置信度 ${answer.confidence?.toFixed(2)} < ${config.below}（模型没把握）`);
	return { ...base, triggered: true, reason: parts.join("；") };
}

/** 合成结论 */
export interface SynthesisResult {
	/** review = 需要弹窗给用户；safe = 可直接放行 */
	outcome: "review" | "safe";
	/** 命中的维度（按风险值降序） */
	hit: DimensionVerdict[];
	/** 一句话摘要（进弹窗标题） */
	summary: string;
}

/**
 * 把各维度判定合成为「要不要打扰用户」。
 *
 * 刻意做得极简：没有任何维度能让请求被**拒绝**（分类器是试验品，不允许它挡死人），
 * 也不做加权求和（维度代价不可比，加权会掩盖某一条极其危险）。就是「任一维度触发 → 弹窗」。
 */
export function synthesize(verdicts: DimensionVerdict[]): SynthesisResult {
	const hit = verdicts
		.filter((v) => v.triggered)
		.sort((a, b) => b.answer.risk - a.answer.risk);

	if (hit.length === 0) return { outcome: "safe", hit: [], summary: "各维度均未超过阈值" };

	const names = hit.slice(0, 3).map((v) => v.label).join("、");
	const more = hit.length > 3 ? ` 等 ${hit.length} 项` : "";
	return {
		outcome: "review",
		hit,
		summary: `${names}${more} 需要你过目`,
	};
}

/** 分类器给出的完整答案集 → 各维度判定 */
export function evaluateAll(
	answers: Record<string, RawAnswer>,
	configs: DimensionConfig[],
): DimensionVerdict[] {
	const out: DimensionVerdict[] = [];
	for (const config of configs) {
		const spec = dimensionById(config.id);
		if (!spec) continue;
		const raw = answers[config.id];
		if (!raw) {
			// 服务端漏答（协议上不该发生）：当作「没答案」跳过，不因此触发提示
			continue;
		}
		out.push(evaluateDimension(spec, normalizeAnswer(spec, raw), config));
	}
	return out;
}

// ═══════════════════════════════════════════════════
// 展示用报告（给审批窗看权重；这是本机自用工具，不做脱敏）
// ═══════════════════════════════════════════════════

/**
 * 单个维度送进审批窗的形态。
 *
 * 都是可 JSON 序列化的原始数据：审批窗要能自己算条宽、自己决定颜色，
 * 而不是让后端把「该显示什么颜色」编码进来。
 */
export interface DimensionReportRow {
	id: string;
	label: string;
	type: Primitive;
	/** 0-1 风险值（choice 取高风险档概率和；score 线性归一化；noul 取「是」概率） */
	risk: number;
	/** 模型自报置信度；noul 无 → undefined（前端显示「无」） */
	confidence?: number;
	/** 原始档位文字（choice 的键 + 说明；score 的分值与档位文字） */
	raw: string;
	/** 是否越过阈值（above / below 任一命中） */
	triggered: boolean;
	/** 触发原因（中文），未触发时为空串 */
	reason: string;
	/** 生效阈值，前端画刻度线用 */
	above: number;
	below: number | null;
	/** choice：全部选项键 → 概率（本机自用，原样带上便于看模型在犹豫什么） */
	probabilities?: Record<string, number>;
	/** choice：选中键；score：分值；noul：无 */
	choice?: string;
	score?: number;
	noul?: number;
	/**
	 * 本次场景下该维度被禁用：没提问、没参与判定。
	 * 行仍要出来——但要让人一眼看出「这次没问」，而不是以为它得了 0 分。
	 */
	disabled?: boolean;
	/** 禁用说明（中文；仅 disabled=true 时带） */
	disabledNote?: string;
}

/**
 * 各维度判定 → 审批窗权重表（按风险降序）。
 *
 * 为什么两种分支都带：safe 也不代表「没人会看」——strict 模式下 safe 同样弹窗，
 * 而且出问题时最该看的就是「模型当时给了什么数」。
 */
export function dimensionReport(verdicts: DimensionVerdict[]): DimensionReportRow[] {
	return [...verdicts]
		.sort((a, b) => b.answer.risk - a.answer.risk)
		.map((v) => rowOf(v));
}

function rowOf(verdict: DimensionVerdict): DimensionReportRow {
	const { answer, config } = verdict;
	const row: DimensionReportRow = {
		id: answer.id,
		label: verdict.label,
		type: answer.type,
		risk: answer.risk,
		raw: answer.raw,
		triggered: verdict.triggered,
		reason: verdict.reason,
		above: config.above,
		below: config.below,
	};
	if (answer.confidence !== undefined) row.confidence = answer.confidence;
	return row;
}

/**
 * 场景禁用的维度 → 审批窗的灰化行。
 *
 * 为什么还要给行：定义没删（也不该删，换场景还要用），人被问到时得看得见
 * 「这一维这次没参与」，而不是以为模型漏答，或把占位的 0 读成「问过、无风险」。
 * 配置里本来就关掉/忽略的维度不出行——那种情况不展示是既有行为，与场景无关。
 *
 * risk 固定 0：没问就没有风险值，占位而已，前端按 disabled 渲染成「—」。
 */
export function disabledReportRows(
	configs: DimensionConfig[],
	scenario: ReviewScenario = "bash",
): DimensionReportRow[] {
	const spec = scenarioSpec(scenario);
	if (spec.disabled.length === 0) return [];
	const byId = new Map(configs.map((c) => [c.id, c]));
	const rows: DimensionReportRow[] = [];
	for (const id of spec.disabled) {
		const dim = dimensionById(id);
		const config = byId.get(id);
		if (!dim || !config) continue;
		if (!config.enabled || config.action === "ignore") continue;
		rows.push({
			id: dim.id,
			label: dim.label,
			type: dim.type,
			risk: 0,
			raw: "",
			triggered: false,
			reason: "",
			above: config.above,
			below: config.below,
			disabled: true,
			disabledNote: spec.disabledNote,
		});
	}
	return rows;
}

/**
 * 与 dimensionReport 同源，但保留概率与原始取值（调试与面板用）。
 * 与 dimensionReport 分开是为了让「给人看的表」保持窄：窗口不需要每次扛上整张概率分布。
 */
export function dimensionReportDetailed(
	answers: Record<string, RawAnswer>,
	verdicts: DimensionVerdict[],
): DimensionReportRow[] {
	return [...verdicts]
		.sort((a, b) => b.answer.risk - a.answer.risk)
		.map((v) => {
			const row = rowOf(v);
			const raw = answers[v.id];
			if (!raw) return row;
			if (raw.probabilities) row.probabilities = { ...raw.probabilities };
			if (raw.choice !== undefined) row.choice = raw.choice;
			if (raw.score !== undefined) row.score = raw.score;
			if (raw.noul !== undefined) row.noul = raw.noul;
			return row;
		});
}
