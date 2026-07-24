/**
 * mktemp 临时目录生命周期 — 安全模式测试
 *
 * 运行：npx tsx extensions/permission-gate/safe-patterns/mktemp-cleanup.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isCommandSafe } from "../helpers";
import { scanMktempAssign, extractRmTargets, extractVarName, mktempCleanup } from "./mktemp-cleanup";

// ---------------------------------------------------------------------------
// 扫描函数单元测试
// ---------------------------------------------------------------------------

describe("scanMktempAssign", () => {
  it("匹配标准形式", () => {
    assert.deepEqual(scanMktempAssign(["tmp=$(mktemp -d)"]), [{ index: 0, varName: "tmp" }]);
  });

  it("匹配 mktemp 无参数", () => {
    assert.deepEqual(scanMktempAssign(["d=$(mktemp)"]), [{ index: 0, varName: "d" }]);
  });

  it("匹配 mktemp -d --suffix", () => {
    assert.deepEqual(scanMktempAssign(["w=$(mktemp -d --suffix .build)"]), [{ index: 0, varName: "w" }]);
  });

  it("不匹配非 mktemp赋值", () => {
    assert.deepEqual(scanMktempAssign(["tmp=$(echo /home)"]), []);
  });

  it("不匹配无赋值", () => {
    assert.deepEqual(scanMktempAssign(["mktemp -d"]), []);
  });

  it("多个赋值", () => {
    const slices = ["a=$(mktemp -d)", "ls", "b=$(mktemp)"];
    assert.deepEqual(scanMktempAssign(slices), [
      { index: 0, varName: "a" },
      { index: 2, varName: "b" },
    ]);
  });
});

describe("extractRmTargets", () => {
  it("单目标", () => {
    assert.deepEqual(extractRmTargets('rm -rf "$tmp"'), ['"$tmp"']);
  });

  it("多目标", () => {
    assert.deepEqual(extractRmTargets('rm -rf "$a" "$b"'), ['"$a"', '"$b"']);
  });

  it("无引号", () => {
    assert.deepEqual(extractRmTargets("rm -rf $tmp"), ["$tmp"]);
  });

  it("不匹配非 rm 命令", () => {
    assert.deepEqual(extractRmTargets("ls -la"), []);
  });

  it("不匹配 rm 无 -rf", () => {
    assert.deepEqual(extractRmTargets("rm file.txt"), []);
  });
});

describe("extractVarName", () => {
  it("双引号 $var", () => {
    assert.equal(extractVarName('"$tmp"'), "tmp");
  });

  it("双引号 ${var}", () => {
    assert.equal(extractVarName('"${tmp}"'), "tmp");
  });

  it("无引号 $var", () => {
    assert.equal(extractVarName("$tmp"), "tmp");
  });

  it("带子路径", () => {
    assert.equal(extractVarName('"$tmp/sub/dir"'), "tmp");
  });

  it("字面路径返回 null", () => {
    assert.equal(extractVarName("/home/user"), null);
  });

  it("根路径返回 null", () => {
    assert.equal(extractVarName("/"), null);
  });
});

// ---------------------------------------------------------------------------
// 处理器单元测试
// ---------------------------------------------------------------------------

describe("mktempCleanup 处理器", () => {
  it("标准形式", () => {
    const slices = ['tmp=$(mktemp -d)', 'cp foo "$tmp/"', 'rm -rf "$tmp"'];
    assert.deepEqual(mktempCleanup(slices), new Set([2]));
  });

  it("rm 在 mktemp 之前 → 不放行", () => {
    const slices = ['rm -rf "$tmp"', 'tmp=$(mktemp -d)'];
    assert.deepEqual(mktempCleanup(slices), new Set());
  });

  it("变量名不一致 → 不放行", () => {
    const slices = ['tmp=$(mktemp -d)', 'rm -rf "$other"'];
    assert.deepEqual(mktempCleanup(slices), new Set());
  });

  it("混合目标和字面路径 → 不放行", () => {
    const slices = ['tmp=$(mktemp -d)', 'rm -rf "$tmp" /important'];
    assert.deepEqual(mktempCleanup(slices), new Set());
  });

  it("无 mktemp 赋值 → 不放行", () => {
    const slices = ['rm -rf "$tmp"'];
    assert.deepEqual(mktempCleanup(slices), new Set());
  });

  it("多个变量各自匹配", () => {
    const slices = [
      'a=$(mktemp -d)', 'b=$(mktemp -d)',
      'rm -rf "$a"', 'rm -rf "$b"',
    ];
    assert.deepEqual(mktempCleanup(slices), new Set([2, 3]));
  });

  it("子路径删除也放行", () => {
    const slices = ['tmp=$(mktemp -d)', 'rm -rf "$tmp/cache"'];
    assert.deepEqual(mktempCleanup(slices), new Set([1]));
  });
});

// ---------------------------------------------------------------------------
// 端到端测试（isCommandSafe）
// ---------------------------------------------------------------------------

describe("端到端：isCommandSafe（mktemp 模式）", () => {
  it("用户原始命令放行", () => {
    const cmd = 'tmp=$(mktemp -d) && cp /some/file.ts "$tmp/" && cd "$tmp" && npx tsc --noEmit file.ts && rm -rf "$tmp"';
    assert.equal(isCommandSafe(cmd), true);
  });

  it("最简形式放行", () => {
    assert.equal(isCommandSafe('tmp=$(mktemp -d) && rm -rf "$tmp"'), true);
  });

  it("无引号变量也放行", () => {
    assert.equal(isCommandSafe("tmp=$(mktemp -d) && rm -rf $tmp"), true);
  });

  it("裸 rm -rf不放行", () => {
    assert.equal(isCommandSafe("rm -rf /important"), false);
  });

  it("变量未赋值不放行", () => {
    assert.equal(isCommandSafe('rm -rf "$tmp"'), false);
  });

  it("混合：一个安全一个危险 → 不放行", () => {
    const cmd = 'tmp=$(mktemp -d) && rm -rf "$tmp" && rm -rf /home';
    assert.equal(isCommandSafe(cmd), false);
  });

  it("与 tmpRecreate 模式共存", () => {
    assert.equal(isCommandSafe("cd /tmp && rm -rf foo && mkdir foo"), true);
  });
});
