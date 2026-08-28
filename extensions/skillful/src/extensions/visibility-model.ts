// visibility-model — skillful-local 批量显隐的纯数据逻辑

import { basename, dirname, normalize, relative } from "node:path";
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

/**
 * 按来源分组；skills/external 下的正式入口使用固定目录结构，
 * 因此从 canonical path 提取 package 名称，比把所有扩展贡献的技能并成一组更准确。
 */
export function groupSkills(skills: LoadedSkillInfo[]): VisibilityGroup[] {
	const groups = new Map<string, VisibilityGroup>();
	for (const skill of skills) {
		const source = skillGroupSource(skill);
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

function skillGroupSource(skill: LoadedSkillInfo): { id: string; label: string } {
	const path = normalize(skill.sourceInfo.path);
	const marker = `${normalize("skills/external")}${normalize("/")}`;
	const externalIndex = path.indexOf(marker);
	if (externalIndex >= 0) {
		const suffix = path.slice(externalIndex + marker.length);
		const packageName = suffix.split("/")[0];
		if (packageName === "moonbit-skills" || packageName === "clyzhi-moonwell-spring") {
			return { id: "external:moonbit-environment", label: "MoonBit 开发环境" };
		}
		if (packageName) return { id: `external:${packageName}`, label: `skill 包：${packageName}` };
	}

	const source = skill.sourceInfo.source || "local";
	const scope = skill.sourceInfo.scope ? ` (${skill.sourceInfo.scope})` : "";
	return { id: `${source}\0${skill.sourceInfo.scope ?? ""}`, label: `${source}${scope}` };
}

export function buildVisibilityRows(skills: LoadedSkillInfo[]): VisibilityRow[] {
	const groups = groupSkills(skills);
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
