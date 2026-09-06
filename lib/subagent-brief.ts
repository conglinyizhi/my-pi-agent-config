// lib/subagent-brief.ts — subagent 任务简报规范化
//
// 兼容旧的 string task，同时为复杂委派提供结构化字段，避免主 agent 漏传
// 背景、必看文件、skill、验收标准后让 worker 反复侦察。

export interface WorkerBriefInput {
  objective: string;
  context?: string;
  constraints?: string[];
  required_files?: string[];
  skills?: string[];
  acceptance?: string[];
  output_format?: string;
}

export interface NormalizedWorkerBrief {
  task: string;
  skills: string[];
}

function lines(title: string, values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return [title, ...values.map((value) => `- ${value}`)];
}

function cleanList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

/** 把结构化简报编成 worker 一次可读完的任务说明。 */
export function normalizeWorkerBrief(
  input: string | WorkerBriefInput,
  inheritedSkills: string[] = [],
): NormalizedWorkerBrief {
  if (typeof input === "string") {
    return { task: input, skills: [...new Set(inheritedSkills.filter(Boolean))] };
  }

  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  if (!objective) throw new Error("structured subagent task requires a non-empty objective");

  const body = [
    "任务目标",
    objective,
    ...(input.context?.trim() ? ["", "必要上下文", input.context.trim()] : []),
    ...(lines("约束", cleanList(input.constraints)).length ? ["", ...lines("约束", cleanList(input.constraints))] : []),
    ...(lines("必看文件 / 目录", cleanList(input.required_files)).length
      ? ["", ...lines("必看文件 / 目录", cleanList(input.required_files))]
      : []),
    ...(lines("验收标准", cleanList(input.acceptance)).length
      ? ["", ...lines("验收标准", cleanList(input.acceptance))]
      : []),
    ...(input.output_format?.trim() ? ["", "输出格式", input.output_format.trim()] : []),
  ].join("\n");

  return {
    task: body,
    skills: [...new Set([...inheritedSkills, ...cleanList(input.skills)])],
  };
}
