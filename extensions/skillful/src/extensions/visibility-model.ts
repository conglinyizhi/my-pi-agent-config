// visibility-model — skillful-local 批量显隐的纯数据逻辑

import { normalize } from "node:path";
import type { SkillGroupRule } from "../config.ts";
import type { LoadedSkillInfo } from "../skills.ts";

export type VisibilityRowKind = "all" | "group" | "skill";

export interface VisibilityGroup {
	id: string;
	label: string;
	skills: LoadedSkillInfo[];
}

export interface VisibilityRow {
	kind: VisibilityRowKind;
	id: string;
	label: string;
	skillNames: string[];
	depth: number;
}

/** 统一成 posix 分隔符，规则片段和 canonical path 才好直接比。 */
function toPosixPath(value: string): string {
	return normalize(value).split(/[\\/]/).join("/");
}

/**
 * 按来源分组。规则（extensions.toml 的 [skillful.skillGroups]）优先：
 * 命中就按规则给的 id/label 合并；未命中按 skills/external 包名或 Pi 的 source/scope 分组。
 */
export function groupSkills(skills: LoadedSkillInfo[], rules: readonly SkillGroupRule[] = []): VisibilityGroup[] {
	const groups = new Map<string, VisibilityGroup>();
	for (const skill of skills) {
		const source = skillGroupSource(skill, rules);
		const current = groups.get(source.id);
		if (current) {
			current.skills.push(skill);
		} else {
			groups.set(source.id, { id: source.id, label: source.label, skills: [skill] });
		}
	}
	return Array.from(groups.values())
		.map((group) => ({ ...group, skills: [...group.skills].sort((a, b) => a.name.localeCompare(b.name)) }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

function skillGroupSource(skill: LoadedSkillInfo, rules: readonly SkillGroupRule[]): { id: string; label: string } {
	const path = toPosixPath(skill.sourceInfo.path);
	// 配置规则优先，按数组顺序先匹配先归组
	for (const rule of rules) {
		if (rule.match.some((pattern) => path.includes(toPosixPath(pattern)))) {
			return { id: rule.id, label: rule.label };
		}
	}

	// 未命中规则：skills/external 下的正式入口结构固定，按包名分组
	const marker = "skills/external/";
	const externalIndex = path.indexOf(marker);
	if (externalIndex >= 0) {
		const suffix = path.slice(externalIndex + marker.length);
		const packageName = suffix.split("/")[0];
		if (packageName) return { id: `external:${packageName}`, label: `skill 包：${packageName}` };
	}

	const source = skill.sourceInfo.source || "local";
	const scope = skill.sourceInfo.scope ? ` (${skill.sourceInfo.scope})` : "";
	return { id: `${source}\0${skill.sourceInfo.scope ?? ""}`, label: `${source}${scope}` };
}

export function buildVisibilityRows(skills: LoadedSkillInfo[], rules: readonly SkillGroupRule[] = []): VisibilityRow[] {
	const groups = groupSkills(skills, rules);
	const rows: VisibilityRow[] = [{
		kind: "all",
		id: "__all__",
		label: "全部技能",
		skillNames: skills.map((skill) => skill.name),
		depth: 0,
	}];
	for (const group of groups) {
		rows.push({ kind: "group", id: group.id, label: group.label, skillNames: group.skills.map((skill) => skill.name), depth: 0 });
		for (const skill of group.skills) {
			rows.push({ kind: "skill", id: skill.name, label: skill.name, skillNames: [skill.name], depth: 1 });
		}
	}
	return rows;
}

/** 按“可见性”语义切换一组：有隐藏项时全部设为可见，否则全部设为隐藏。 */
export function toggleVisibleNames(hidden: Set<string>, names: Iterable<string>): Set<string> {
	const next = new Set(hidden);
	const unique = [...new Set(names)];
	const makeVisible = unique.some((name) => next.has(name));
	for (const name of unique) {
		if (makeVisible) next.delete(name);
		else next.add(name);
	}
	return next;
}

export function setAllVisible(hidden: Set<string>, names: Iterable<string>, visible: boolean): Set<string> {
	const next = new Set(hidden);
	for (const name of new Set(names)) {
		if (visible) next.delete(name);
		else next.add(name);
	}
	return next;
}

export function rowState(hidden: Set<string>, names: Iterable<string>): "hidden" | "visible" | "partial" {
	const unique = [...new Set(names)];
	if (unique.length === 0 || unique.every((name) => hidden.has(name))) return "hidden";
	if (unique.every((name) => !hidden.has(name))) return "visible";
	return "partial";
}
