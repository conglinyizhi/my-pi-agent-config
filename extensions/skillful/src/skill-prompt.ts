// Portions adapted from pi-skillful 0.4.0, Copyright (c) 2026 Jose Mocito, MIT.

import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

// 兼容两种包裹：老格式前面两个换行；pi 1.0.2 起把这段包进了 <skills> 且句子前只有一个换行。
// 2026-10-05 实测：老正则遇到新格式静默失配，replaceSkillsSection 返回 undefined，
// 于是整个可见性过滤被跳过而没人发现——这里把两种形状都认下，别再让格式变动静默吃掉功能。
export const SKILLS_SECTION_PATTERN =
  /\n*(?:<skills>\n)?The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;

export function replaceSkillsSection(systemPrompt: string, skills: Skill[]): string | undefined {
  const next = systemPrompt.replace(SKILLS_SECTION_PATTERN, formatSkillsForPrompt(skills));
  return next === systemPrompt ? undefined : next;
}
