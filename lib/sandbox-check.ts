// lib/sandbox-check.ts — 沙盒命令判定层（公共库）
//
// 目的：把「bash 命令执行前的前置检查」提成判定层，供接管 bash 的插件
// （bash-guard）与后台任务（bash_background）共用，替代 gate/guard 里基于
// tool_call 事件的 hook 拦截。检查逻辑内聚在工具执行前，不依赖事件链。
//
// 设计（用户确认：本次先「引用现有 sandbox-permissions 模块」轻量落地，
// 反向依赖等工程完成后下一轮再调整收敛）：
//   - 判定纯函数复用 extensions/sandbox-permissions 的 rule-engine/scanner/
//     paths/inline-script（均为纯导出、无副作用）。
//   - 本库只做「组装 + 高层入口」，不复制逻辑。
//   - 对外两个函数：
//       checkCommand(command, ctx)  → 判定层：命中黑名单/内联脚本/危险规则/白名单
//       buildSandboxEnv()           → spawnHook 用：生成注入子进程的 PI_SANDBOX_* env
//
// 沙箱通道说明：底层真正的执行走 lib/sandboxed-command.ts 的
// createLocalBashOperations（settings.shellPath → sandbox-shell.mjs → Landlock）。
// 本库不管执行通道，只管「要不要放行」。两者叠在 bash-guard 的 execute 里。

import { commandBlocked, loadBlacklist, matchBlacklistHits, pathBlocked } from "../extensions/sandbox-permissions/guard.ts";
import { maskHeredocBodies, maskNonInterpreterHeredocBodies } from "../extensions/sandbox-permissions/scanner.ts";
import { analyzeCommand, formatFacts, loadPreshellConfig, type PreshellFacts } from "./preshell.ts";
import {
  auditCommand,
  extractTmpRedirectTargets,
  isTmpRedirectTargetSafe,
  narrowableProgramName,
  type AuditResult,
  type TokenRule,
} from "../extensions/sandbox-permissions/rule-engine.ts";
import { isWhitelisted, loadSandboxPaths } from "../extensions/sandbox-permissions/paths.ts";
import {
  buildInlineScriptRejection,
  extractInlineScript,
  saveInlineScript,
} from "../extensions/sandbox-permissions/inline-script.ts";

export type { AuditResult, TokenRule, PreshellFacts };
export { formatFacts };

export interface SandboxCheckContext {
	/** 当前工作目录（白名单判断、路径解析用） */
	cwd: string;
	/** allowDirs 缓存；缺省实时读 sandbox-paths.json */
	allowDirs?: string[];
	/**
	 * 命中敏感路径黑名单时的处置：
	 *   "block"（默认）→ 硬拒，不给人工放行的口子（普通 bash / worker bash 走这条）
	 *   "ask"        → 不在判定层拒绝，由调用方弹审批问人（sandbox-allow 走这条）
	 * 升权工具存在的意义就是让用户对「越界但正当」的操作拍板，而 .env 这类项目配置
	 * 文件正是最常被黑名单误伤的一类；但它仍不能被静默放行，所以降为「要人点头」。
	 */
	sensitivePaths?: "block" | "ask";
}

/** 敏感路径黑名单命中项（供审批窗展示与命令高亮） */
export interface SensitivePathHit {
	/** 配置里写的那条模式原文（如 ".env" / "~/.ssh/**"） */
	pattern: string;
	/** 命令里实际命中的片段（GUI 高亮用；可能是 /path/.env 这样带路径段的写法） */
	token: string;
	/** 这条命中是谁报出来的：解析出的事实（preshell），还是未引号 token 的兜底扫描 */
	via?: "preshell" | "token" | "interpreter" | "legacy";
}

/**
 * 命令里「未被引号包裹、且看起来像路径」的 token。
 *
 * 这是事实层的补集，专治 preshell 不报 Read 的那类（存在性探测：`test -f .env`）、
 * 以及事实层不可用时的兼底。引号内的内容不当路径看：`grep "process.env"` 里的
 * `.env` 是模式不是路径（旧实现拿子串匹配，在这类上误伤了 14 条）。
 */
export function unquotedPathTokens(command: string): string[] {
	const tokens = new Set<string>();
	let current = "";
	let quoted = false;
	let skipped = false;
	const flush = () => {
		if (current && !skipped) tokens.add(current);
		current = "";
		skipped = false;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quoted = !quoted;
			skipped = true; // 这个 token 里出现过引号：整体不当路径用（交给 preshell）
			continue;
		}
		if (!quoted && /[\s;|&()<>\n]/.test(ch)) {
			flush();
			continue;
		}
		current += ch;
	}
	flush();
	return [...tokens].filter((token) => {
		if (token.length < 2 || token.startsWith("-")) return false;
		return token.includes("/") || token.startsWith("~") || token.startsWith(".") || /\.[A-Za-z0-9]{1,8}$/.test(token);
	});
}

/**
 * 会把「代码/数据」当输入的程序：解释器，或脚本文件本身。
 *
 * 这类程序的参数（-c / -e）里可能藏着路径，而 preshell 不建模它们的行为（`modeled: false`）：
 * 那些路径既不产生 Read 效果，也不在未引号 token 里。拿它们当信号退回旧的子串匹配：
 * 宁可多问一次，也不让事实层的盲区变成放行。但只扫**载荷本身**（见 detectSensitivePaths），
 * 不扫整条命令，否则命令里嵌的代码/正文文本会把无关的 `.env` 字样也带进来。
 *
 * 刻意不含 git / ssh / docker / make 这类「输入不是代码」的程序：
 *   - git 已被 preshell 建模（报 .git 的写），且提交信息里提到 .env 是常有的事
 *   - ssh/scp 那一串里的 ~/.ssh 是**远端**路径，拦它会把正当的运维流程一起挡掉
 */
export const INTERPRETER_PROGRAMS = [
	"python", "python2", "python3", "node", "nodejs", "deno", "bun", "ruby", "perl", "php", "lua",
	"bash", "sh", "zsh", "dash", "ksh", "eval", "base64", "xxd", "openssl",
];

/** 脚本类后缀：`/tmp/xxx/rs22.sh '...'` 这种把命令串当输入交给本地脚本的写法 */
const SCRIPT_SUFFIX = /\.(?:sh|bash|zsh|ksh|dash|py|py3|rb|pl|php|lua|js|mjs|cjs|ts)$/i;

/** Exec/Spawn 的目标是不是「解释器 / 脚本」（按 basename 判，含 python3.12 这类版本后缀） */
export function isInterpreterProgram(target: string): boolean {
	const base = target.split("/").pop()?.toLowerCase() ?? "";
	const stem = base.replace(/\d+(\.\d+)*$/, "");
	return INTERPRETER_PROGRAMS.includes(base) || INTERPRETER_PROGRAMS.includes(stem) || SCRIPT_SUFFIX.test(base);
}

/**
 * 命令名位置那个引用的规范化键：`$x` 与 `${x}` 是同一处引用（preshell 报的是 `$x`，
 * 而 pi 的 token 可能是 `${x}` 这种带花括号的写法）。不是变量引用（`$(...)`、`eval`、`-c`…）
 * 返回 undefined：那些没有候选可言。
 */
function programRefKey(reference: string): string | undefined {
	const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(reference.trim());
	return m ? `$${m[1]}` : undefined;
}

/**
 * 命令名位置一处引用在事实层里的取值。
 *
 * 两个来源合在一张表里（都以规范化引用 `$x` 为键）：
 *   - `dynamic: false` 且带 `origin` → 工具已经把值解出来了（v0.4.1），单元素、`certain: true`
 *   - `dynamic: true` 且 `candidates` 非空 → 候选集（v0.4.0），`certain: false`
 * 两类都只是「这个位置可能跑什么」的描述，不是安全结论：判定侧拿它们过同一道窄门槛，
 * 过了也只是从「未知动态构造」改成「交预审」
 */
export interface ProgramValues {
	programs: string[];
	/** true = 事实层解出的确定值（每个使用点都是一个定值）；false = 候选集（跑的是其中之一） */
	certain: boolean;
}

/**
 * preshell 对命令名位置给出的取值：规范化引用（`$x`）→ 确定值或候选集。
 *
 * 两类都看：
 *   - 确定值（v0.4.1 的 `origin`）：`x=/usr/bin/jq; $x -n 1` 报的是 `Exec: /usr/bin/jq`，
 *     程序名在命令文本里根本不出现，只有 `origin: "$x"` 能把这个效果对回命令名位置。
 *     只认 `dynamic: false` 的那些：`dynamic: true` 时 target 本身就是引用原文，不是解出来的值
 *   - 候选集（v0.4.0 的 `candidates`）：条件分支让名字有多个取值时才有，`dynamic: true`
 *
 * 同一个键出现多条时取并集，`certain` 要求「每条都是确定值且只剩一个取值」：
 * 一个名字在两处使用点（或一条命令写了两遍）可能各报一条，并集永远是可能取值的
 * 超集，而窄门槛是「全过才收窄」，往大了算是保守的那一侧。
 *
 * 旧二进制（≤v0.4.0 没有 origin）或没装 preshell 时这里拿到的是一张空表，
 * 判定与接入前完全一致。
 */
export function preshellProgramValues(facts: PreshellFacts | undefined): Map<string, ProgramValues> {
	const programs = new Map<string, string[]>();
	const allCertain = new Map<string, boolean>();
	const add = (key: string, values: string[], certain: boolean) => {
		const seen = programs.get(key);
		programs.set(key, seen ? [...new Set([...seen, ...values])] : [...new Set(values)]);
		allCertain.set(key, (allCertain.get(key) ?? true) && certain);
	};
	for (const effect of facts?.effects ?? []) {
		if (effect.kind !== "Exec" && effect.kind !== "Spawn") continue;
		if (effect.dynamic === true) {
			if (!Array.isArray(effect.candidates)) continue;
			const key = programRefKey(effect.target);
			if (!key) continue;
			const values = effect.candidates.filter((v): v is string => typeof v === "string" && v.length > 0);
			if (values.length === 0) continue;
			add(key, values, false);
			continue;
		}
		// 确定值：v0.4.1 起才有 origin，旧报告里这个字段是 undefined（那就当没这回事）
		if (typeof effect.origin !== "string" || effect.target.length === 0) continue;
		const key = programRefKey(effect.origin);
		if (!key) continue;
		add(key, [effect.target], true);
	}
	const found = new Map<string, ProgramValues>();
	for (const [key, values] of programs) {
		found.set(key, { programs: values, certain: allCertain.get(key) === true && values.length === 1 });
	}
	return found;
}

/** 一条命令名变量的取值：token 是引用原文，programs 是确定值（单元素）或候选集 */
export interface ProgramCandidate {
	token: string;
	programs: string[];
	/** true = 事实层解出的确定值；false = 候选集（跑的是其中之一） */
	certain: boolean;
}

/**
 * 把命令名位置那些「取值全落在已知程序上」的引用从 dynamic-construct 里摘出来。
 *
 * 两类输入走同一道门槛：确定值（v0.4.1 的 origin）与候选集（v0.4.0 的 candidates）。
 * 门槛只有一个：narrowableProgramName（与 pi 自己的静态渲染用同一道，见 rule-engine）。
 * 有一个取值过不了（rm / sudo / 解释器 / `/tmp` 下的程序 / 脚本…）就整个保动态构造——
 * 候选是「其中之一」，不能拿一部分候选的“看着安全”去替另一部分担保。
 *
 * 「确定值」比「候选」多的是信息，不是保证：值本身也可能过不了窄门槛（`x=/tmp/tool; $x`），
 * 那就照旧算动态构造（收窄与否只看门槛，不看这个是确定值还是候选集）。
 *
 * 摘出去≠放行：调用方仍会出一条 autoReject:false 的 dynamic-construct-narrowed 规则，
 * 命令照样进 LLM 预审（与 pi 自己渲染出程序名时走同一条）。
 */
export function splitProgramCandidates(
	tokens: readonly string[],
	values: Map<string, ProgramValues>,
): { keep: string[]; narrowed: ProgramCandidate[] } {
	const keep: string[] = [];
	const narrowed: ProgramCandidate[] = [];
	for (const token of tokens) {
		const key = programRefKey(token);
		const hint = key ? values.get(key) : undefined;
		if (hint && hint.programs.length > 0 && hint.programs.every(narrowableProgramName)) {
			narrowed.push({ token, programs: hint.programs, certain: hint.certain });
			continue;
		}
		keep.push(token);
	}
	return { keep, narrowed };
}

/**
 * 取值描述给审核模型看的一句话。
 * 两类事实的写法不同，但都不能写成「已确定安全」：
 *   - 确定值：事实层已解出它是什么程序（但仍是预审项，不是放行）
 *   - 候选集：措辞不能写成「已确定为」——候选是可能性（跑的是其中之一），交预审时要让人/模型
 *     看出这是集合而不是事实
 * 共用的是「`引用 = 值`」这个形状（审批窗高亮、模型对命令行都用它）。
 */
function describeProgramValues(items: readonly ProgramCandidate[]): string {
	return items.map((item) => `${item.token} = ${item.programs.join("、")}`).join("；");
}

/**
 * 敏感路径黑名单：解析出来的目标优先，未引号 token 兜底。
 *
 * 三层都跑（而非二选一），是因为它们盖的是不同的洞：
 *   preshell    → 相对路径、带引号的路径、cd 后的基准（旧子串匹配在相对路径上漏了 21 条）；
 *                  v0.3.0 起还包括它交出的变量与 `~` 目标，由我们用环境变量收尾成绝对路径；
 *                  v0.4.0 起还包括动态目标的候选集（`if c; then x=/a; else x=/b; fi; rm $x`
 *                  里的 /a 与 /b），逐个当路径判——候选是「其中之一」，不是在拿可能性当事实
 *   token       → 存在性探测这类不产生 Read 效果的用法（preshell 对 `test -f x` 只报 Exec）
 *   interpreter → 解释器载荷（`node -e …` / `python -c …` / 交给解释器的 heredoc 正文）：
 *                   preshell 不建模这类程序，引号里的路径既没效果也不在未引号 token 里
 *   事实层不可用 → 整条退回旧匹配（宁可多拦，不能因为缺工具而变宽）
 *   报告被截断 / 语法错 → 同样退回旧匹配（工具说「这份影响面不是完备集合」时就当它没给全）
 * 误伤那一侧靠三条约束压住：只在未引号 token 上匹配、用锚定的路径规则、
 * 不把 heredoc 正文当操作数（它往往是脚本/文本内容，真操作对象是中段里的写目标，preshell 已经报了）。
 */
export function detectSensitivePaths(
	command: string,
	ctx: SandboxCheckContext,
): { hits: SensitivePathHit[]; facts?: PreshellFacts; unavailable?: string } {
	const rules = loadBlacklist();
	const hits: SensitivePathHit[] = [];
	const seen = new Set<string>();
	const push = (pattern: string, token: string, via: SensitivePathHit["via"]) => {
		const key = `${pattern}\u0000${token}`;
		if (seen.has(key)) return;
		seen.add(key);
		hits.push({ pattern, token, via });
	};

	const outcome = analyzeCommand(command, { config: loadPreshellConfig(), cwd: ctx.cwd });
	let interpreterPayload = false;
	if (outcome.ok) {
		const base = outcome.facts.cwd ?? ctx.cwd;
		for (const effect of outcome.facts.effects) {
			if ((effect.kind === "Exec" || effect.kind === "Spawn") && isInterpreterProgram(effect.target)) interpreterPayload = true;
		}
		// 路径判定用收尾后的目标（v0.3.0 起工具交出 `$HOME/x` / `~/x` 这类原值与 vars，
		// 由 facts.settledPaths 用环境变量替换成绝对路径）。收尾失败的条目 path 仍是工具给的
		// 原值，跟以前一样拿它去匹配：不会比接入前更松
		for (const item of outcome.facts.settledPaths) {
			if (!["Read", "Write", "Delete"].includes(item.effect.kind)) continue;
			if (item.path.length > 0) {
				const hit = rules.find((rule) => pathBlocked(item.path, base, [rule]));
				if (hit) push(hit.pattern, item.path, "preshell");
			}
			// v0.4.0 的候选集：动态目标的 target 是 `$x` 这种引用，item.path 不是真路径
			// （变量补不上就保留原值，等于判不了），以前这类只能漏。候选集里那些确定的值
			// 逐个按同一套规则判一遍，命中就拦。方向只会更严：候选是「其中之一」，
			// 命中的那个可能本来就是要跑的那个；而 `$x` 原文从来不会匹配上黑名单
			if (item.effect.dynamic === true && Array.isArray(item.effect.candidates)) {
				for (const candidate of item.effect.candidates) {
					if (typeof candidate !== "string" || candidate.length === 0) continue;
					const hit = rules.find((rule) => pathBlocked(candidate, base, [rule]));
					if (hit) push(hit.pattern, candidate, "preshell");
				}
			}
		}
	}

	// token 层：heredoc 正文先遮掉。正文是数据（脚本、文档、提交信息），
	// 把里面的 ".env" / "~/.ssh" 字样当路径 token 是我实测踩到的那类误伤
	for (const token of unquotedPathTokens(maskHeredocBodies(command))) {
		const hit = rules.find((rule) => pathBlocked(token, ctx.cwd, [rule]));
		if (hit) push(hit.pattern, token, "token");
	}

	// 退一步的那一层：解释器载荷，以及事实层不完整时的整条退回
	if (interpreterPayload) {
		// 只扫交给解释器的那段载荷：`node -e …` 的参数、会被解释器消费的 heredoc 正文。
		// 同一条命令里另写的脚本正文（`cat > x.ts <<EOF`，之后再用 node 跑）不是载荷
		for (const hit of matchBlacklistHits(maskNonInterpreterHeredocBodies(command, isInterpreterProgram), rules)) {
			push(hit.pattern, hit.token, "interpreter");
		}
	}
	// 报告被截断（effects/issues 到上限）或语法错时不拿它当完备集合：整条再退回旧匹配。
	// uncertain 不在此列：真实命令里它占 65%，拿它降级等于把误报全带回来
	const incomplete = outcome.ok && (outcome.facts.effectsDropped > 0 || outcome.facts.issuesDropped > 0 || outcome.facts.status === "Invalid");
	if (!outcome.ok || incomplete) {
		for (const hit of matchBlacklistHits(command, rules)) push(hit.pattern, hit.token, "legacy");
	}

	return {
		hits,
		...(outcome.ok ? { facts: outcome.facts } : { unavailable: outcome.reason }),
	};
}

export interface SandboxCheckResult {
	/** 是否放行 */
	allow: boolean;
	/** 拦截原因（block 时非空），供工具返回 reason/text */
	reason?: string;
	/** 命中的危险规则（仅规则层；黑名单/内联脚本不在此列） */
	rules?: TokenRule[];
	/** audit 明细（供需要细分展示的调用方） */
	audit?: AuditResult;
	/**
	 * 敏感路径黑名单命中（sensitivePaths="ask" 时才填充）。
	 * 不并进 rules：rules 是「命令写法有风险」的语义，会连带影响目录长期授权（grantSafe）；
	 * 黑名单命中是「目标路径敏感」，两者不是一回事。
	 */
	sensitive?: SensitivePathHit[];
	/** 命令事实（preshell）；拿不到时为 undefined，看 factsUnavailable */
	facts?: PreshellFacts;
	/** 事实层不可用的原因（缺二进制/超时/坏 JSON/契约版本不符…）：此时走保守兼底 */
	factsUnavailable?: string;
}

/** 读取当前生效的黑名单规则（含动态 blockDirs），供命令前缀/路径判定 */
export function loadSandboxRules(): ReturnType<typeof loadBlacklist> {
	return loadBlacklist();
}

/**
 * 把命中的 token 拼成一句能塞进审批提示的摘要。
 * token 可能是 `$P` / `eval` / `probe()`，也可能是整段命令替换 `$(...)`，
 * 所以单个 token 要截断、条数也要封顶，否则 tip 会把审批窗撜爆。
 * 摘要里不保留换行：多行 token 折成一行，免得提示框被撞开。
 */
export function summarizeTokens(tokens: string[], maxItems = 4, maxChars = 32): string {
	const flatten = (t: string) => t.replace(/\s+/g, " ").trim();
	const shown = tokens.slice(0, maxItems).map((t) => {
		const one = flatten(t);
		return one.length > maxChars ? `${one.slice(0, maxChars)}…` : one;
	});
	const rest = tokens.length - shown.length;
	return rest > 0 ? `${shown.join("、")} 等 ${tokens.length} 项` : shown.join("、");
}

/**
 * 判定层主入口：一条 bash 命令是否放行。
 * 顺序与 gate/guard 的原拦截顺序对齐：敏感路径 → 内联脚本 → 危险规则 → 白名单豁免。
 * 返回 { allow:false, reason } 时调用方应在执行前阻止。
 */
export function checkCommand(command: string, ctx: SandboxCheckContext): SandboxCheckResult {
	if (!command || command.trim().length === 0) {
		return { allow: false, reason: "[sandbox-check] 空命令，未执行" };
	}

	// 1. 敏感路径黑名单（guard：防恶意 skill 读浏览器密码/密钥/凭据）
	//    路径判定走事实层（preshell 解析出的读/写/删目标）+ 未引号 token 兼底，
	//    不再拿模式对整条命令做子串匹配（那会把引号内的字符串与模板文件名也算命中）。
	const sensitive = detectSensitivePaths(command, ctx);
	if (sensitive.hits.length > 0) {
		const patterns = [...new Set(sensitive.hits.map((hit) => hit.pattern))].join("、");
		if (ctx.sensitivePaths === "ask") {
			return {
				allow: false,
				reason: `[sandbox-guard] 命令引用了敏感路径黑名单（${patterns}）：默认拒绝，本次需人工确认。`,
				sensitive: sensitive.hits,
				...(sensitive.facts ? { facts: sensitive.facts } : {}),
				...(sensitive.unavailable ? { factsUnavailable: sensitive.unavailable } : {}),
			};
		}
		return {
			allow: false,
			reason: `[sandbox-guard] bash 命中敏感路径黑名单（${sensitive.hits[0].pattern}）：${command.slice(0, 120)}`,
			...(sensitive.facts ? { facts: sensitive.facts } : {}),
			...(sensitive.unavailable ? { factsUnavailable: sensitive.unavailable } : {}),
		};
	}

	// 下面各条返回都带上 facts：上层（LLM 预审 / 审批窗 / 审计条目）拿它看事实，
	// 不再只拿一条原始命令字符串去猜。拿不到就带 factsUnavailable，让上层能说出来。
	const withFacts = <T extends SandboxCheckResult>(result: T): T => ({
		...result,
		...(sensitive.facts ? { facts: sensitive.facts } : {}),
		...(sensitive.unavailable ? { factsUnavailable: sensitive.unavailable } : {}),
	});

	// 2. 内联脚本拦截（inline-script：python/node 裸脚本）
	const inline = extractInlineScript(command);
	if (inline) {
		try {
			const saved = saveInlineScript(inline);
			return withFacts({ allow: false, reason: buildInlineScriptRejection(saved) });
		} catch (err) {
			return withFacts({ allow: false, reason: `[sandbox-check] 拦截内联脚本且保存失败：${(err as Error).message}` });
		}
	}

	// 3. 危险命令规则判定（rule-engine：rm/find/sudo/dd + 动态构造 + Python + 管道）
	const audit = auditCommand(command);

	// /tmp 重定向逃逸（符号链接指向 /tmp 之外视为危险）
	const tmpEscape = extractTmpRedirectTargets(command).filter((t) => !isTmpRedirectTargetSafe(t));

	// 完全安全 → 放行。
	// 收窄过的命令名变量（`P=/usr/bin/jq && $P -n 1`）不走这条：程序名虽然能静态确定，
	// 但规则层看不到 `$P` 背后是什么，要留出一条 dynamic-construct-narrowed 规则送去 LLM 预审。
	// 同一条件再写一遍是故意的：这是当初把收窄误成「直接放行」的那个口子（audit.allow 已会
	// 因 narrowed 变 false，但直接从这条分支走的人不会知道）。
	if (audit.allow && audit.narrowed.length === 0 && tmpEscape.length === 0) {
		return withFacts({ allow: true, audit });
	}

	// 组装规则：audit 命中的 + tmp 逃逸单独成一条
	const rulesOut: TokenRule[] = [...audit.rules];
	if (tmpEscape.length > 0) {
		rulesOut.push({ name: "write-redirect-symlink", tip: "重定向目标符号链接指向 /tmp 之外", matched: [...tmpEscape] });
	}

	// 组合危险信号（与 gate 一致：不合并成一条，逐条可高亮）
	// preshell 对命令名位置的变量给出两类事实（见 preshellProgramValues）：确定值（v0.4.1 的
	// origin）与候选集（v0.4.0 的 candidates）。取值全落在已知程序上就把它从 dynamic-construct
	// 摘到 dynamic-construct-narrowed——那是同一条「仍要 LLM 预审」的路，只是 tip 里多给
	// 模型一层信息（到底跑什么）。有一个取值过不了窄门槛就留在 dynamic 里（保守）：
	// 候选是可能性、确定值也可能是个 /tmp 下的程序，两者都得过同一道门槛。
	// 事实层不可用 / 旧版没 origin 与 candidates 时那张表是空的，这里就是原来的行为
	const { keep, narrowed: factNarrowed } = audit.dynamic
		? splitProgramCandidates(audit.dynamicTokens, preshellProgramValues(sensitive.facts))
		: { keep: audit.dynamicTokens, narrowed: [] as ProgramCandidate[] };

	// tip 里带上命中的 token：只说「含动态构造」的话，人得自己在一屏命令里找是哪一处
	if (audit.dynamic && keep.length > 0) {
		rulesOut.push({
			name: "dynamic-construct",
			tip: `命令含动态构造（${summarizeTokens(keep)}），请人工确认`,
			autoReject: false,
			matched: [...keep],
		});
	}
	// 收窄过的命令名变量：程序名静态确定了（或取值全落在已知程序上），但规则层拿着 token 原文
	// 判不了它是什么程序。这条规则把这层信息交给审核模型（tip 里带上 `$P = /usr/bin/jq`），
	// 仍要预审，不直接放行。autoReject:false 是硬要求：它只把命令送进 LLM 预审，不能让 LLM
	// 判 safe 之后还要人工（那是真·危险信号才该给的待遇）。
	// 三个来源合并成一条：pi 自己的静态渲染（已确定为）、事实层解出的确定值（v0.4.1）、
	// 事实层的候选集（可能是）。前两者说的是同一件事的两个来源，同一个引用不重复报。
	const staticKeys = new Set(audit.narrowed.map((n) => programRefKey(n.token) ?? n.token));
	const factOnly = factNarrowed.filter((n) => !staticKeys.has(programRefKey(n.token) ?? n.token));
	const certainFromFacts = factOnly.filter((n) => n.certain);
	const candidateFromFacts = factOnly.filter((n) => !n.certain);
	const narrowedParts: string[] = [];
	const narrowedTokens: string[] = [];
	if (audit.narrowed.length > 0) {
		narrowedParts.push(`命令名是变量，已静态确定为 ${audit.narrowed.map((n) => `${n.token} = ${n.program}`).join("、")}`);
		narrowedTokens.push(...audit.narrowed.map((n) => n.token));
	}
	// 确定值（origin）：事实已经解出跑的是什么程序。措辞与「已静态确定」区分开——来源不同
	// （一个是 pi 自己的静态渲染，一个是事实层解出的赋值），但同样不能写成「已确定安全」：
	// 这条规则是 autoReject:false 的预审项，收窄只是把命令从「未知动态构造」换成「知道跑什么」
	if (certainFromFacts.length > 0) {
		narrowedParts.push(`命令名是变量，事实层已解出它是 ${describeProgramValues(certainFromFacts)}`);
		narrowedTokens.push(...certainFromFacts.map((n) => n.token));
	}
	if (candidateFromFacts.length > 0) {
		narrowedParts.push(
			`命令名是变量，事实层给出的候选全落在已知程序上（${describeProgramValues(candidateFromFacts)}，跑的是其中之一）`,
		);
		narrowedTokens.push(...candidateFromFacts.map((n) => n.token));
	}
	if (narrowedParts.length > 0) {
		rulesOut.push({
			name: "dynamic-construct-narrowed",
			tip: `${narrowedParts.join("；")}，交预审确认`,
			autoReject: false,
			matched: narrowedTokens,
		});
	}
	if (audit.dangerous.length > 0) rulesOut.push({ name: "subst-danger", tip: "命令替换内部含危险指令", autoReject: false, matched: [...audit.dangerous] });
	if (audit.pyDanger.length > 0) rulesOut.push({ name: "python-danger", tip: "Python 段含危险调用", autoReject: false, matched: [...audit.pyDanger] });
	if (audit.pipeExec.length > 0) rulesOut.push({ name: "pipe-exec", tip: "管道右侧为执行器命令", autoReject: false, matched: [...audit.pipeExec] });

	// 4. 全部规则都是 autoReject → 自动拒绝。
	// 长期 allowDirs 只减少写权限相关的重复审批，不能绕过硬拒绝规则。
	if (rulesOut.length > 0 && rulesOut.every((r) => r.autoReject)) {
		const tip = rulesOut.map((r) => r.tip).join("；");
		return withFacts({ allow: false, reason: `自动拒绝：${tip}`, rules: rulesOut });
	}

	// 5. 白名单目录豁免：所有目标路径都在 allowDirs 内 → 放行（gate 同款逻辑）。
	// 放在 autoReject 之后，避免 allowDirs 把硬拒绝命令放过去。
	const allowDirs = ctx.allowDirs ?? loadSandboxPaths().allowDirs;
	const whitelisted = isWhitelisted(command, allowDirs);
	if (whitelisted) {
		return withFacts({ allow: true, audit, rules: rulesOut });
	}

	// 6. 有规则但非全 autoReject（动态构造/收窄待预审/需人工确认）→ 交由上层（bash-guard）走 LLM/弹窗审批
	// 这里只做「判定」，不弹窗。调用方拿到 rules 后自行决定审批方式。
	// 收窄过的命令也落在这条（rules 里只有 dynamic-construct-narrowed 这一条 autoReject:false 时）：
	// 白名单豁免走不到它——isWhitelisted 见命令含 `$` 就返 false——所以它一定会到审批器。
	return withFacts({ allow: false, reason: "命令需人工确认（命中危险/动态规则）", rules: rulesOut, audit });
}

/**
 * spawnHook 用：生成注入子进程的 PI_SANDBOX_* env。
 * 默认不注入（sandbox-shell.mjs 已默认 --ro / + --rw <cwd>/tmp 的 Landlock）。
 * 需要升权/只读时由此扩展场景注入 PI_SANDBOX_RW_EXTRA / PI_SANDBOX_READONLY。
 */
export function buildSandboxEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base };
}
