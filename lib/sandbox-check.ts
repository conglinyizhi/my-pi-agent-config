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
import { analyzeCommand, formatFacts, loadPreshellConfig, type PreshellFacts } from "./preshell.ts";
import {
  auditCommand,
  extractTmpRedirectTargets,
  isTmpRedirectTargetSafe,
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
 * 这类程序的参数（-c / -e）与 heredoc 正文、命令行字符串里可能藏着路径，而 preshell 不建模
 * 它们的行为（`modeled: false`）：那些路径既不产生 Read 效果，也不在未引号 token 里。
 * 拿它们当信号退回旧的子串匹配：宁可多问一次，也不让事实层的盲区变成放行。
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
 * 敏感路径黑名单：解析出来的目标优先，未引号 token 兜底。
 *
 * 三层都跑（而非二选一），是因为它们盖的是不同的洞：
 *   preshell    → 相对路径、带引号的路径、cd 后的基准（旧子串匹配在相对路径上漏了 21 条）
 *   token       → 存在性探测这类不产生 Read 效果的用法（preshell 对 `test -f x` 只报 Exec）
 *   interpreter → 解释器载荷里的路径（`node <<EOF …` / `python -c "open('凭据文件')"`）：
 *                   preshell 不建模这类程序，引号里的路径既没效果也不在未引号 token 里
 *   事实层不可用 → 整条退回旧匹配（宁可多拦，不能因为缺工具而变宽）
 * 误伤那一侧靠 token 化的三条约束压住：只在未引号 token 上匹配、用锚定的路径规则、
 * 不再对每一条命令都做 includes：解释器载荷（preshell 不建模的那类）与事实层不可用时才退回去。
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

	const outcome = analyzeCommand(command, { config: loadPreshellConfig() });
	let interpreterPayload = false;
	if (outcome.ok) {
		const base = outcome.facts.cwd ?? ctx.cwd;
		for (const effect of outcome.facts.effects) {
			if (effect.kind === "Exec" || effect.kind === "Spawn") {
				if (isInterpreterProgram(effect.target)) interpreterPayload = true;
				continue;
			}
			if (!["Read", "Write", "Delete"].includes(effect.kind)) continue;
			if (typeof effect.target !== "string" || effect.target.length === 0) continue;
			const hit = rules.find((rule) => pathBlocked(effect.target, base, [rule]));
			if (hit) push(hit.pattern, effect.target, "preshell");
		}
	}

	for (const token of unquotedPathTokens(command)) {
		const hit = rules.find((rule) => pathBlocked(token, ctx.cwd, [rule]));
		if (hit) push(hit.pattern, token, "token");
	}

	// 退一步的那一层：解释器载荷（引号/heredoc 正文里的路径）与事实层不可用
	if (interpreterPayload || !outcome.ok) {
		const via: SensitivePathHit["via"] = outcome.ok ? "interpreter" : "legacy";
		for (const hit of matchBlacklistHits(command, rules)) push(hit.pattern, hit.token, via);
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

	// 完全安全 → 放行
	if (audit.allow && tmpEscape.length === 0) {
		return withFacts({ allow: true, audit });
	}

	// 组装规则：audit 命中的 + tmp 逃逸单独成一条
	const rulesOut: TokenRule[] = [...audit.rules];
	if (tmpEscape.length > 0) {
		rulesOut.push({ name: "write-redirect-symlink", tip: "重定向目标符号链接指向 /tmp 之外", matched: [...tmpEscape] });
	}

	// 组合危险信号（与 gate 一致：不合并成一条，逐条可高亮）
	if (audit.dynamic) rulesOut.push({ name: "dynamic-construct", tip: "命令含动态构造，请人工确认", autoReject: false, matched: [...audit.dynamicTokens] });
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

	// 6. 有规则但非全 autoReject（动态构造/需人工确认）→ 交由上层（bash-guard）走 LLM/弹窗审批
	// 这里只做「判定」，不弹窗。调用方拿到 rules 后自行决定审批方式。
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
