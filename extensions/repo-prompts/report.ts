// report.ts — /repo-prompts 的输出组装（纯函数，便于单测）
//
// 命令给的是「配置真相 + 运行真相」两份：
//   - 规则来自命令执行时重新读的规则表（改完立刻能在报告里看到）
//   - 段来自 factory 期注册的那批（改完要 /reload 才生效）
// 两者数量不一致时报告里点一句，省得对着配置改半天发现没生效。
//
// 「这条规则来自哪个 toml」是这里要说清的关键：规则表由目录下多个 *.toml 合并而来，
// 同名还会覆盖，不标来源就只能对着文件猜。

import type { LoadedRules, Rule } from "./config.ts";
import { readTextCached } from "./content.ts";
import type { RegisteredSection } from "./sections.ts";
import { matchingRules } from "./match.ts";

export interface ReportInput {
	dir: string;
	loaded: LoadedRules;
	registered: RegisteredSection[];
	cwd: string;
	enabled: boolean;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 路径在存储目录里就只显示文件名（目录上面已经打过），否则给全路径 */
function labelInDir(path: string, dir: string): string {
	const prefix = dir.endsWith("/") ? dir : `${dir}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function describeSource(rule: Rule, dir: string): string {
	if (rule.text !== undefined) return `内联 text（${rule.text.length} 字符）`;
	const file = rule.file ?? "(未解析)";
	const read = readTextCached(file);
	// 正文在存储目录里就只显示文件名（存储目录上面已经打过），否则给全路径
	const label = rule.rawFile ? labelInDir(file, dir) : file;
	return read.ok ? `${label}（读得到，${formatBytes(read.bytes ?? 0)}）` : `${label}（读不到：${read.reason}）`;
}

/** 规则定义在哪个 toml */
function describeTable(rule: Rule, dir: string): string {
	return rule.source ? labelInDir(rule.source, dir) : "(未知)";
}

export function buildReport(input: ReportInput): string {
	const { loaded, registered, cwd } = input;
	const hits = matchingRules(loaded.rules, cwd);
	const lines: string[] = [];

	lines.push(`repo-prompts: ${input.enabled ? "启用" : "已关闭（extensions.toml [repo-prompts] enabled=false）"}`);
	lines.push(`存储: ${input.dir}`);
	lines.push(`规则: ${loaded.rules.length} 条 · 已注册段: ${registered.length} 个`);
	if (loaded.configFiles.length === 0) {
		lines.push(`规则表: 不存在（${loaded.configPath}）—— 还没配规则`);
	} else {
		lines.push(`规则表: ${loaded.configFiles.length} 个 toml（按文件名序合并，同名后者覆盖）`);
		for (const file of loaded.configFiles) lines.push(`  ${labelInDir(file, input.dir)}`);
	}
	lines.push(`当前 cwd: ${cwd}`);
	if (hits.length === 0) {
		lines.push("命中: 无");
	} else {
		lines.push(`命中: ${hits.map((r) => r.name).join(", ")}`);
	}

	if (loaded.rules.length > 0) {
		lines.push("");
		loaded.rules.forEach((rule, index) => {
			const matched = hits.includes(rule);
			lines.push(`[${index + 1}] ${rule.name}  order=${rule.order}${matched ? "  ← 命中" : ""}`);
			lines.push(`    paths: ${rule.rawPaths.join(", ")}`);
			lines.push(`    归一化: ${rule.paths.join(", ")}`);
			lines.push(`    规则表: ${describeTable(rule, input.dir)}`);
			lines.push(`    来源: ${describeSource(rule, input.dir)}`);
		});
	}

	if (registered.length > 0) {
		lines.push("");
		lines.push("已注册段:");
		for (const section of registered) {
			lines.push(`  ${section.name} (order=${section.order}${section.inline ? ", 内联" : ""})`);
		}
	}

	if (registered.length !== loaded.rules.length) {
		lines.push("");
		lines.push(`注意: 规则数(${loaded.rules.length})与已注册段数(${registered.length})不一致 —— 规则表在加载后变过，/reload 后生效`);
	}

	if (loaded.notes.length > 0) {
		lines.push("");
		lines.push("提示:");
		for (const note of loaded.notes) lines.push(`  - ${note}`);
	}

	if (loaded.errors.length > 0) {
		lines.push("");
		lines.push("问题:");
		for (const error of loaded.errors) lines.push(`  - ${error}`);
	}

	return lines.join("\n");
}
