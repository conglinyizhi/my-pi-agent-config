// skillful-local config — hidden skill visibility only
// Migrated from pi-skillful 0.4.0 (MIT; see ../LICENSE-MIT).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SkillfulScope = "global" | "project";

interface PiSettingsDocument {
	skillful?: { hiddenSkills?: unknown };
	[key: string]: unknown;
}

export function globalSettingsPath(): string {
	return join(homedir(), ".pi", "agent", "settings.json");
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

export function normalizeSkillName(name: string): string {
	return name.trim().replace(/^skill:/, "");
}

export function normalizeSkillNames(names: Iterable<string>): string[] {
	return Array.from(new Set(Array.from(names).map(normalizeSkillName).filter(Boolean))).sort();
}

async function readSettings(path: string): Promise<PiSettingsDocument> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PiSettingsDocument : {};
	} catch {
		return {};
	}
}

export async function readSkillfulSettings(path: string): Promise<{ hiddenSkills: string[]; defined: boolean }> {
	const settings = await readSettings(path);
	const value = settings.skillful?.hiddenSkills;
	return {
		hiddenSkills: normalizeSkillNames(Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []),
		defined: !!settings.skillful && Object.hasOwn(settings.skillful, "hiddenSkills"),
	};
}

export async function readEffectiveHiddenSkills(cwd: string, projectTrusted: boolean): Promise<Set<string>> {
	const global = await readSkillfulSettings(globalSettingsPath());
	if (!projectTrusted) return new Set(global.hiddenSkills);
	const project = await readSkillfulSettings(projectSettingsPath(cwd));
	return new Set(project.defined ? project.hiddenSkills : global.hiddenSkills);
}

export async function readScopedHiddenSkills(cwd: string, projectTrusted: boolean): Promise<{
	global: { hiddenSkills: string[]; defined: boolean };
	project: { hiddenSkills: string[]; defined: boolean };
}> {
	const global = await readSkillfulSettings(globalSettingsPath());
	const project = projectTrusted
		? await readSkillfulSettings(projectSettingsPath(cwd))
		: { hiddenSkills: [], defined: false };
	return { global, project };
}

export async function writeHiddenSkills(
	scope: SkillfulScope,
	cwd: string,
	hiddenSkills: Iterable<string>,
	projectTrusted = false,
): Promise<void> {
	if (scope === "project" && !projectTrusted) throw new Error("Project skillful settings require a trusted project.");
	const path = scope === "global" ? globalSettingsPath() : projectSettingsPath(cwd);
	const settings = await readSettings(path);
	const skillful = settings.skillful && typeof settings.skillful === "object" && !Array.isArray(settings.skillful)
		? { ...settings.skillful }
		: {};
	skillful.hiddenSkills = normalizeSkillNames(hiddenSkills);
	settings.skillful = skillful;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
