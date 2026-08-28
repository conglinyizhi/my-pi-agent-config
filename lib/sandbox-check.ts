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

import { commandBlocked, loadBlacklist } from "../extensions/sandbox-permissions/guard.ts";
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

export type { AuditResult, TokenRule };

export interface SandboxCheckContext {
	/** 当前工作目录（白名单判断、路径解析用） */
	cwd: string;
	/** allowDirs 缓存；缺省实时读 sandbox-paths.json */
	allowDirs?: string[];
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
	const rules = loadBlacklist();
	const hit = rules.find((r) => commandBlocked(command, [r]));
	if (hit) {
		return { allow: false, reason: `[sandbox-guard] bash 命中敏感路径黑名单（${hit.pattern}）：${command.slice(0, 120)}` };
	}

	// 2. 内联脚本拦截（inline-script：python/node 裸脚本）
	const inline = extractInlineScript(command);
	if (inline) {
		try {
			const saved = saveInlineScript(inline);
			return { allow: false, reason: buildInlineScriptRejection(saved) };
		} catch (err) {
			return { allow: false, reason: `[sandbox-check] 拦截内联脚本且保存失败：${(err as Error).message}` };
		}
	}

	// 3. 危险命令规则判定（rule-engine：rm/find/sudo/dd + 动态构造 + Python + 管道）
	const audit = auditCommand(command);

	// /tmp 重定向逃逸（符号链接指向 /tmp 之外视为危险）
	const tmpEscape = extractTmpRedirectTargets(command).filter((t) => !isTmpRedirectTargetSafe(t));

	// 完全安全 → 放行
	if (audit.allow && tmpEscape.length === 0) {
		return { allow: true, audit };
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
		return { allow: false, reason: `自动拒绝：${tip}`, rules: rulesOut };
	}

	// 5. 白名单目录豁免：所有目标路径都在 allowDirs 内 → 放行（gate 同款逻辑）。
	// 放在 autoReject 之后，避免 allowDirs 把硬拒绝命令放过去。
	const allowDirs = ctx.allowDirs ?? loadSandboxPaths().allowDirs;
	const whitelisted = isWhitelisted(command, allowDirs);
	if (whitelisted) {
		return { allow: true, audit, rules: rulesOut };
	}

	// 6. 有规则但非全 autoReject（动态构造/需人工确认）→ 交由上层（bash-guard）走 LLM/弹窗审批
	// 这里只做「判定」，不弹窗。调用方拿到 rules 后自行决定审批方式。
	return { allow: false, reason: "命令需人工确认（命中危险/动态规则）", rules: rulesOut, audit };
}

/**
 * spawnHook 用：生成注入子进程的 PI_SANDBOX_* env。
 * 默认不注入（sandbox-shell.mjs 已默认 --ro / + --rw <cwd>/tmp 的 Landlock）。
 * 需要升权/只读时由此扩展场景注入 PI_SANDBOX_RW_EXTRA / PI_SANDBOX_READONLY。
 */
export function buildSandboxEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base };
}
