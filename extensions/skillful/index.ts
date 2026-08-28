// skillful-local — 从 pi-skillful 迁移的技能发现、显隐与显式调用核心
//
// 当前只接入三项能力：
//   - progressive-skills：发现 git 根目录之外的 .agents/skills/
//   - skill-visibility：按全局/项目设置隐藏技能
//   - inline-skill-invocation：在输入任意位置展开 /skill:name
//
// 暂不迁移 session skill toggles，也不包含原包的安装遥测。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import inlineSkillInvocation from "./src/extensions/inline-skill-invocation.ts";
import progressiveSkills from "./src/extensions/progressive-skills.ts";
import skillVisibility from "./src/extensions/skill-visibility.ts";

export default function skillfulLocal(pi: ExtensionAPI): void {
	progressiveSkills(pi);
	inlineSkillInvocation(pi);
	skillVisibility(pi);
}
