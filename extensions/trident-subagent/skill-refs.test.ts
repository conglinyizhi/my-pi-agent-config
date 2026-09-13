// skill-refs.test.ts — subagent skill 引用解析单测
//
// 重点钉住三件事：
//   1. 解析交给 pi 的发现结果（loadSkills），**任意深度**都能命中——
//      旧实现只认两层，36 个 skill 里静默丢 25 个（moonbit 全家 / superpowers 全家）。
//   2. 引用支持「名称」与「路径」两种写法；解析不到一律进 unresolved，绝不静默丢弃。
//   3. 未命中的报错把可用名称摆出来，让主 agent 自己重选。
//
// 全部在临时目录里建合成 skill，不依赖本机装了哪些 skill。
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/skill-refs.test.ts

import assert from "node:assert";
import { after, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSkillIndex,
  expandSkillRef,
  formatUnresolvedSkills,
  looksLikePath,
  resolveSkillRefs,
  type SkillIndex,
} from "./skill-refs.ts";

const tmpRoots: string[] = [];

function tmpDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-skillrefs-${label}-`));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/** 在 root/rel 下造一个合法 skill（frontmatter 必须有 name + description） */
function makeSkill(root: string, rel: string, name: string, description = "合成测试技能"): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf-8",
  );
  return dir;
}

function indexOf(entries: Array<[string, string]>): SkillIndex {
  return {
    byName: new Map(entries),
    names: entries.map(([name]) => name).sort(),
  };
}

describe("expandSkillRef / looksLikePath", () => {
  it("~ 与 ~/ 展开到 home，绝对路径原样，相对路径按 cwd 解析", () => {
    const home = "/home/tester";
    assert.strictEqual(expandSkillRef("~", "/work", home), home);
    assert.strictEqual(expandSkillRef("~/a/b", "/work", home), path.join(home, "a/b"));
    assert.strictEqual(expandSkillRef("/abs/x", "/work", home), "/abs/x");
    assert.strictEqual(expandSkillRef("./rel", "/work", home), path.resolve("/work", "./rel"));
    assert.strictEqual(expandSkillRef("  spaced/x  ", "/work", home), path.resolve("/work", "spaced/x"));
  });

  it("名称不被当成路径；含分隔符/以点或 ~ 开头/以 .md 结尾算路径", () => {
    for (const name of ["moonbit-orientation", "git-commit", "a.b", "x_y"]) {
      assert.strictEqual(looksLikePath(name), false, name);
    }
    for (const p of ["/abs", "~/x", "./x", "../x", "a/b", "x.md", "C:\\x", "a\\b"]) {
      assert.strictEqual(looksLikePath(p), true, p);
    }
    assert.strictEqual(looksLikePath("   "), false);
  });
});

describe("buildSkillIndex（交给 pi 的递归发现）", () => {
  it("深层嵌套的 SKILL.md 也能解析——这是旧实现丢掉 25 个 skill 的根因", () => {
    const agentDir = tmpDir("agent");
    const cwd = tmpDir("cwd");
    const home = tmpDir("home"); // 隔离 ~/.agents/skills，避免读到本机真实技能
    makeSkill(agentDir, "skills/shallow", "shallow-skill");
    makeSkill(agentDir, "skills/group/deep/nested", "deep-skill");
    makeSkill(cwd, ".pi/skills/project-local", "project-skill");

    const index = buildSkillIndex({ cwd, agentDir, home });
    assert.ok(index.byName.has("shallow-skill"));
    assert.ok(index.byName.has("deep-skill"), "四层嵌套的 skill 必须能解析");
    assert.ok(index.byName.has("project-skill"), "项目本地 skill 也要能解析");
    assert.ok(index.byName.get("deep-skill")?.endsWith(path.join("group", "deep", "nested")));
    // 名称列表升序，供未命中时提示
    assert.deepStrictEqual(index.names, [...index.names].sort());
  });

  it("不存在的额外根不会污染结果", () => {
    const agentDir = tmpDir("agent2");
    const cwd = tmpDir("cwd2");
    makeSkill(agentDir, "skills/only", "only-skill");
    const index = buildSkillIndex({ cwd, agentDir, home: tmpDir("home2") });
    assert.deepStrictEqual(index.names, ["only-skill"]);
  });
});

describe("resolveSkillRefs", () => {
  const index = indexOf([
    ["moonbit-orientation", "/skills/external/moonbit-skills/skills/moonbit-orientation"],
    ["git-commit", "/home/u/.agents/skills/git-commit"],
  ]);

  it("名称命中查表，顺序保持，重复只留一次", () => {
    const r = resolveSkillRefs(
      ["moonbit-orientation", "git-commit", "moonbit-orientation"],
      index,
      "/work",
    );
    assert.deepStrictEqual(r.paths, [
      "/skills/external/moonbit-skills/skills/moonbit-orientation",
      "/home/u/.agents/skills/git-commit",
    ]);
    assert.deepStrictEqual(r.unresolved, []);
  });

  it("解析不到的引用进 unresolved，不静默丢弃", () => {
    const r = resolveSkillRefs(["moonbit-orientation", "no-such-skill"], index, "/work");
    assert.strictEqual(r.paths.length, 1);
    assert.deepStrictEqual(r.unresolved, ["no-such-skill"]);
  });

  it("空白引用跳过，不报未命中（参数里常有空串）", () => {
    const r = resolveSkillRefs(["", "   ", "git-commit"], index, "/work");
    assert.strictEqual(r.paths.length, 1);
    assert.deepStrictEqual(r.unresolved, []);
  });

  it("路径直通：存在的目录 / .md 文件可用，不存在的进 unresolved", () => {
    const cwd = tmpDir("cwd3");
    const skillDir = makeSkill(cwd, "local/skill-a", "skill-a");
    const mdFile = path.join(cwd, "loose.md");
    fs.writeFileSync(mdFile, "# loose\n", "utf-8");

    const r = resolveSkillRefs([skillDir, mdFile, "./local/skill-a", "/nope/missing"], index, cwd);
    assert.deepStrictEqual(r.paths, [skillDir, mdFile]); // 第三项与第一项同路径 → 去重
    assert.deepStrictEqual(r.unresolved, ["/nope/missing"]);
  });

  it("非 skill 的普通文件（非 .md）不算合法路径", () => {
    const cwd = tmpDir("cwd4");
    const plain = path.join(cwd, "notes.txt");
    fs.writeFileSync(plain, "x", "utf-8");
    const r = resolveSkillRefs([plain], index, cwd);
    assert.deepStrictEqual(r.paths, []);
    assert.deepStrictEqual(r.unresolved, [plain]);
  });

  it("空输入返回空结果", () => {
    const r = resolveSkillRefs([], index, "/work");
    assert.deepStrictEqual(r, { paths: [], unresolved: [] });
  });
});

describe("formatUnresolvedSkills（把事实摆给主 agent）", () => {
  it("列出未命中项与全部可用名称，并说明两种写法", () => {
    const index = indexOf([
      ["alpha-skill", "/s/a"],
      ["beta-skill", "/s/b"],
    ]);
    const text = formatUnresolvedSkills(["typo-skill"], index);
    assert.match(text, /找不到 skill/);
    assert.match(text, /"typo-skill"/);
    assert.match(text, /共 2 个/);
    assert.match(text, /alpha-skill、beta-skill/);
    assert.match(text, /名称/);
    assert.match(text, /路径/);
    assert.match(text, /拒绝启动 worker/);
  });

  it("名称过多时截断并报出剩余数量", () => {
    const entries: Array<[string, string]> = Array.from({ length: 10 }, (_, i) => [`s-${i}`, `/s/${i}`]);
    const text = formatUnresolvedSkills(["nope"], indexOf(entries), 4);
    assert.match(text, /s-0、s-1、s-2、s-3/);
    assert.match(text, /还有 6 个/);
  });
});
