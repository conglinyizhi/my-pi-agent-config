// skill-refs.ts — subagent 的 skill 引用解析（权威来源 + 显式路径直通）
//
// 为什么不再自己扫目录：pi 的 skill 发现是**递归的**（目录含 SKILL.md 即技能根，
// 否则继续递归子目录），而且还包含 settings / 包 / CLI 提供的路径。自己写「扫到
// 第几层」等于复刻 pi 的规则，只会跟它漂移——旧实现只认两层，36 个 skill 里静默
// 丢掉 25 个（含 moonbit 全家与 superpowers 全家），主 agent 以为加载了、其实没加载。
// 现在直接调 pi 自己的 loadSkills（系统提示词用的同一套解析），名称 → 路径由 pi 给出。
//
// 两种引用都接受：
//   - 名称：按 pi 的发现结果查表（重名以 pi 的胜出者为准）
//   - 路径：绝对/相对/~ 展开后的目录或 .md 文件，直通（覆盖 settings / 包等位置）
//
// 解析不到就**响亮报错**，绝不静默丢弃：静默丢弃才是真正的坑。

import { loadSkills } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SkillIndex {
  /** 名称 → 绝对路径（含 SKILL.md 的目录；无 baseDir 时退化为 SKILL.md 文件） */
  byName: Map<string, string>;
  /** 全部可用名称（升序，供未命中时提示主 agent 重选） */
  names: string[];
}

export interface SkillResolution {
  /** 解析成功的绝对路径，与输入同序、去重 */
  paths: string[];
  /** 无法解析的引用（原样回传，保持与输入一致以便对账） */
  unresolved: string[];
}

/**
 * pi 文档列出的全局位置中 loadSkills 的 includeDefaults 不覆盖的那个。
 * 存在才传（避免给不存在的路径制造 warning diagnostic）。
 */
export function defaultExtraSkillRoots(home: string = os.homedir()): string[] {
  return [path.join(home, ".agents", "skills")];
}

/**
 * 用 pi 自己的发现结果建名称索引（同步；每次派发建一次）。
 * includeDefaults 覆盖 <agentDir>/skills 与 <cwd>/.pi/skills，两者都是递归发现。
 */
export function buildSkillIndex(opts: {
  cwd: string;
  agentDir: string;
  home?: string;
}): SkillIndex {
  const extra = defaultExtraSkillRoots(opts.home).filter((p) => fs.existsSync(p));
  const { skills } = loadSkills({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    skillPaths: extra,
    includeDefaults: true,
  });
  const byName = new Map<string, string>();
  for (const skill of skills) {
    // pi 已按加载顺序处理重名（先到者胜）；这里保持同样的先到者语义
    if (!byName.has(skill.name)) byName.set(skill.name, skill.baseDir || skill.filePath);
  }
  return { byName, names: [...byName.keys()].sort() };
}

/** 展开 ~ 并相对 cwd 解析（纯字符串处理，不碰磁盘） */
export function expandSkillRef(ref: string, cwd: string, home: string = os.homedir()): string {
  const trimmed = ref.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return path.join(home, trimmed.slice(2));
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
}

/**
 * 引用是否长得像路径——决定走「查表」还是「直通」。
 * 含分隔符、以 ~ / . 开头、以 .md 结尾、或 Windows 盘符。
 */
export function looksLikePath(ref: string): boolean {
  const t = ref.trim();
  if (!t) return false;
  return (
    t.startsWith("/") ||
    t.startsWith("~") ||
    t.startsWith(".") ||
    t.includes("/") ||
    t.includes("\\") ||
    t.endsWith(".md") ||
    /^[A-Za-z]:[\\/]/.test(t)
  );
}

/** 目录（pi 会自己递归）或 .md 文件都算合法 skill 路径 */
function existsAsSkillPath(abs: string): boolean {
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) return true;
    return st.isFile() && abs.endsWith(".md");
  } catch {
    return false;
  }
}

/**
 * 解析一批 skill 引用。纯函数语义：只查表 / 查盘，不写盘。
 * 同一路径重复出现只保留一次（保持首次出现的位置）。
 */
export function resolveSkillRefs(refs: string[], index: SkillIndex, cwd: string): SkillResolution {
  const paths: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs ?? []) {
    const trimmed = (ref ?? "").trim();
    if (!trimmed) continue;
    const resolved = looksLikePath(trimmed)
      ? (() => {
          const abs = expandSkillRef(trimmed, cwd);
          return existsAsSkillPath(abs) ? abs : undefined;
        })()
      : index.byName.get(trimmed);
    if (!resolved) {
      unresolved.push(trimmed);
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    paths.push(resolved);
  }
  return { paths, unresolved };
}

/**
 * 未命中时的可操作报错：把可用名称直接列给主 agent，让它自己重选。
 * 这是「让大模型决策传什么 skill」的落点——工具不猜、不兜底，只把事实摆清楚。
 */
export function formatUnresolvedSkills(
  unresolved: string[],
  index: SkillIndex,
  maxNames = 48,
): string {
  const shown = index.names.slice(0, maxNames);
  const more = index.names.length - shown.length;
  return [
    `错误：找不到 skill ${unresolved.map((u) => `"${u}"`).join("、")}，已拒绝启动 worker（不做静默丢弃）。`,
    "",
    `pi 当前可解析的 skill 共 ${index.names.length} 个，名称如下：`,
    `  ${shown.join("、")}${more > 0 ? ` …（还有 ${more} 个）` : ""}`,
    "",
    "两种写法都可以：",
    "  - 名称：要与上面的发现结果完全一致；",
    "  - 路径：直接传系统提示词里那个绝对路径（SKILL.md 所在目录，或 .md 文件本身）。",
  ].join("\n");
}
