/**
 * prompt-sections — DSH system-prompt 组装机制的 pi 移植（纯 TS，零 pi 依赖）
 *
 * 语义照抄 @deepseek-ai/dsh-system-prompt（见 docs/plans/2026-08-15-dsh-architecture-migration.md §6）：
 * - 有序段（section）注册表，按 order 升序拼接，空段丢弃、空行分隔
 * - 约定 order：-100 身份 / 0 默认提示词 / 50 策略 / 100-199 工具指导 / 200+ 动态
 * - 严格 {{variable}} 插值：已注册变量求值，undefined 抛错；未注册引用保留字面量
 *   （pi 链兼容的偏离：skill-kit 等下游扩展会在装配后做自己的占位符替换）
 * - complete 段：装配后成为唯一提示词（仍解析变量）；多个有效 complete 段抛错
 * - 同名重复注册 = 遮蔽（后注册者替换先注册者，DSH scope 遮蔽的模块级等价物）；
 *   返回 disposer，仅当仍是当前注册时删除
 * - 装配时隐式注入 order-0 的 `pi:default` 段（= before_agent_start 链上的当前
 *   默认系统提示词）；注册同名段即可整体遮蔽（persona 替换，DSH dsh-persona 等价物）
 *
 * 用法（在扩展 factory 里无条件注册，禁用时不会被装配，无需感知加载顺序）：
 *   import { registerSection, registerVariable } from "../../lib/prompt-sections.ts";
 *   registerSection({ name: "tool-guidance:my-ext", order: 150, text: () => "...", complete: false });
 */

export interface PromptSection {
	/** 唯一名；同名重复注册遮蔽前值。禁用的装配不会渲染任何段，注册本身无害。 */
	readonly name: string;
	/** 升序拼接。约定：-100 身份 / 0 默认提示词 / 50 策略 / 100-199 工具指导 / 200+ 动态 */
	readonly order: number;
	/**
	 * 静态文本、按次装配求值的提供方（可异步，如等待检测完成）。
	 * 返回空串 = 空段丢弃。DSH 原版为同步，pi 生态允许异步提供方。
	 */
	readonly text: string | ((ctx: AssembleContext) => string | Promise<string>);
	/** 装配后成为唯一提示词；多个有效 complete 段抛错 */
	readonly complete?: boolean;
}

/** 一次装配的上下文（prompt-sections 扩展在 before_agent_start 时构造） */
export interface AssembleContext {
	/** 当前工作目录 */
	cwd: string;
	/** 当前模型 id（可能 undefined） */
	model?: string;
	/** YYYY-MM-DD（本地时区） */
	date: string;
	/** HH:mm（本地时区） */
	time: string;
	/** 本轮用户提示词原文 */
	prompt: string;
	/** pi 默认组装好的系统提示词（before_agent_start 链上的当前值） */
	defaultSystemPrompt: string;
	[key: string]: unknown;
}

/** 一段已解析（未插值）的段 */
export interface AssembledSection {
	name: string;
	text: string;
}

/** 装配产物：段 + 变量（渲染前不插值） */
export interface PromptAssembly {
	sections: AssembledSection[];
	variables: Record<string, string | undefined>;
}

interface SectionRegistration extends PromptSection {
	/** 标识当前注册对象，供 disposer 做身份比较 */
	readonly _id: symbol;
}

/** 隐式默认段：占 order-0 位，装配时注入 */
export const DEFAULT_SECTION_NAME = "pi:default";
export const DEFAULT_SECTION_ORDER = 0;

const sections = new Map<string, SectionRegistration>();
const variables = new Map<string, (ctx: AssembleContext) => string | undefined | Promise<string | undefined>>();
let enabled = false;

/** 全局开关（由 prompt-sections 扩展在启动时按 settings/flag 设置；其他扩展只读） */
export function setPromptSectionsEnabled(value: boolean): void {
	enabled = value;
}
export function isPromptSectionsEnabled(): boolean {
	return enabled;
}

/**
 * 注册一个有序段。同名重复注册 = 遮蔽（后注册者替换先注册者，旧注册的 disposer 失效）。
 * @returns disposer：仅当该注册仍是当前注册时移除它
 */
export function registerSection(section: PromptSection): () => void {
	const registration: SectionRegistration = { ...section, _id: Symbol("prompt-section") };
	let disposed = false;
	const disposer = (): void => {
		if (disposed) return;
		disposed = true;
		if (sections.get(section.name) === registration) {
			sections.delete(section.name);
		}
	};
	sections.set(section.name, registration);
	return disposer;
}

const VARIABLE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * 注册一个提示词变量（按次装配求值，可异步）。名字须匹配 [a-z][a-z0-9_]*；
 * provider 返回 undefined 时渲染抛错（DSH 严格语义）。同名重复注册遮蔽前值。
 * @returns disposer：仅当该 provider 仍是当前注册时移除它
 */
export function registerVariable(
	name: string,
	provider: (ctx: AssembleContext) => string | undefined | Promise<string | undefined>,
): () => void {
	if (!VARIABLE_NAME_RE.test(name)) {
		throw new Error(`prompt-sections: 非法变量名 '${name}'（须匹配 ${VARIABLE_NAME_RE}）`);
	}
	let disposed = false;
	const disposer = (): void => {
		if (disposed) return;
		disposed = true;
		if (variables.get(name) === provider) {
			variables.delete(name);
		}
	};
	variables.set(name, provider);
	return disposer;
}

/** 返回当前全部段（含隐式 pi:default 占位标记，name=DEFAULT_SECTION_NAME 时以显式注册为准） */
export function getSections(): PromptSection[] {
	return Array.from(sections.values());
}

export function getVariables(): string[] {
	return Array.from(variables.keys());
}

/** 清除所有段与变量（测试用） */
export function resetRegistry(): void {
	sections.clear();
	variables.clear();
}

/**
 * 装配（异步）：解析全部段（升序），求值全部变量；隐式注入 order-0 的 pi:default 段
 * （可用同名注册遮蔽）；丢弃空段；多个有效 complete 段抛错，恰一个则只保留它。
 */
export async function assemble(ctx: AssembleContext): Promise<PromptAssembly> {
	const vars: Record<string, string | undefined> = {};
	for (const [name, provider] of variables) {
		vars[name] = await provider(ctx);
	}

	const resolve = async (text: PromptSection["text"]): Promise<string> => {
		const value = typeof text === "function" ? await (text as (c: AssembleContext) => string | Promise<string>)(ctx) : text;
		return value ?? "";
	};

	const explicitDefault = sections.get(DEFAULT_SECTION_NAME);
	const entries = Array.from(sections.values());
	if (!explicitDefault) {
		entries.push({
			name: DEFAULT_SECTION_NAME,
			order: DEFAULT_SECTION_ORDER,
			text: () => ctx.defaultSystemPrompt,
			_id: Symbol("implicit-pi-default"),
		});
	}
	// Array.prototype.sort 在 V8 是稳定排序：同 order 保持注册序
	entries.sort((a, b) => a.order - b.order);

	const resolved: AssembledSection[] = [];
	const completes: SectionRegistration[] = [];
	for (const entry of entries) {
		const text = await resolve(entry.text);
		if (!text.trim()) continue; // 空段丢弃（DSH renderPrompt 语义）
		if (entry.complete) completes.push(entry);
		resolved.push({ name: entry.name, text });
	}

	if (completes.length > 1) {
		throw new Error(
			`prompt-sections: 多个有效 complete 段: ${completes.map((c) => c.name).join(", ")}`,
		);
	}

	const finalSections =
		completes.length === 1
			? resolved.filter((s) => s.name === completes[0].name)
			: resolved;

	return { sections: finalSections, variables: vars };
}

const VARIABLE_REF_RE = /\{\{([a-z][a-z0-9_]*)\}\}/g;

/**
 * 严格插值：已注册变量求值（undefined 抛 PromptVariableError）；未注册引用保留
 * 字面量（pi 链兼容偏离——skill-kit 等下游扩展会在装配后替换它们）。替换后的值
 * 不再二次扫描（DSH 语义）；孤立的 `{{`（无配对的 `}}`）视为散文保留。
 */
export function interpolate(text: string, vars: Record<string, string | undefined>): string {
	return text.replace(VARIABLE_REF_RE, (match, name: string) => {
		if (!(name in vars)) return match;
		const value = vars[name];
		if (value === undefined) {
			throw new PromptVariableError(`prompt-sections: 变量 '{{${name}}}' 未定义（provider 返回 undefined）`);
		}
		return value;
	});
}

export class PromptVariableError extends Error {}

/**
 * 渲染：对每段做严格插值、丢弃空段、trim 后以空行拼接。
 * @returns 全部段为空时返回 ''
 */
export function renderPrompt(assembly: PromptAssembly): string {
	const rendered: string[] = [];
	for (const section of assembly.sections) {
		const text = interpolate(section.text, assembly.variables).trim();
		if (!text) continue;
		rendered.push(text);
	}
	return rendered.join("\n\n");
}
