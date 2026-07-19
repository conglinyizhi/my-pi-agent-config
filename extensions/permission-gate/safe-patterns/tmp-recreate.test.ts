/**
 * /tmp 临时目录重建 — 安全模式测试
 *
 * 运行：npx tsx extensions/permission-gate/safe-patterns/tmp-recreate.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitSlices, findDangerousSlices, isCommandSafe } from "../helpers";
import { scanCdTmp, scanRmRf, scanMkdir, tmpRecreate } from "./tmp-recreate";

// ---------------------------------------------------------------------------
// 扫描函数单元测试
// ---------------------------------------------------------------------------

describe("scanCdTmp", () => {
  it("匹配标准形式", () => {
    assert.deepEqual(scanCdTmp(["cd /tmp", "rm -rf foo"]), [0]);
  });

  it("多个 cd /tmp", () => {
    assert.deepEqual(scanCdTmp(["cd /tmp", "ls", "cd /tmp"]), [0, 2]);
  });

  it("不匹配 cd /tmp/subdir", () => {
    assert.deepEqual(scanCdTmp(["cd /tmp/subdir"]), []);
  });

  it("不匹配 cd /tmp/..", () => {
    assert.deepEqual(scanCdTmp(["cd /tmp/.."]), []);
  });
});

describe("scanRmRf", () => {
  it("匹配 rm -rf <dir>", () => {
    assert.deepEqual(scanRmRf(["rm -rf foo"]), [{ index: 0, dir: "foo" }]);
  });

  it("匹配 rm -r <dir>", () => {
    assert.deepEqual(scanRmRf(["rm -r foo"]), [{ index: 0, dir: "foo" }]);
  });

  it("不匹配多参数 rm", () => {
    assert.deepEqual(scanRmRf(["rm -rf foo bar"]), []);
  });

  it("不匹配无参数 rm", () => {
    assert.deepEqual(scanRmRf(["rm -rf"]), []);
  });
});

describe("scanMkdir", () => {
  it("匹配 mkdir <dir>", () => {
    assert.deepEqual(scanMkdir(["mkdir foo"]), [{ index: 0, dir: "foo" }]);
  });

  it("不匹配 mkdir -p <dir>", () => {
    assert.deepEqual(scanMkdir(["mkdir -p foo"]), []);
  });

  it("不匹配多参数 mkdir", () => {
    assert.deepEqual(scanMkdir(["mkdir foo bar"]), []);
  });
});

// ---------------------------------------------------------------------------
// 处理器单元测试
// ---------------------------------------------------------------------------

describe("tmpRecreate 处理器", () => {
  it("标准形式", () => {
    const slices = ["cd /tmp", "rm -rf foo", "mkdir foo"];
    assert.deepEqual(tmpRecreate(slices), new Set([0, 1, 2]));
  });

  it("不同目录名", () => {
    const slices = ["cd /tmp", "rm -rf foo", "mkdir bar"];
    assert.deepEqual(tmpRecreate(slices), new Set());
  });

  it("顺序错误：rm 在 cd 前", () => {
    const slices = ["rm -rf foo", "cd /tmp", "mkdir foo"];
    assert.deepEqual(tmpRecreate(slices), new Set());
  });

  it("顺序错误：mkdir 在 rm 前", () => {
    const slices = ["cd /tmp", "mkdir foo", "rm -rf foo"];
    assert.deepEqual(tmpRecreate(slices), new Set());
  });

  it("无 cd /tmp", () => {
    const slices = ["rm -rf foo", "mkdir foo"];
    assert.deepEqual(tmpRecreate(slices), new Set());
  });

  it("前后可链其他命令", () => {
    const slices = ["git clone url", "cd /tmp", "rm -rf foo", "mkdir foo", "echo done"];
    assert.deepEqual(tmpRecreate(slices), new Set([1, 2, 3]));
  });

  it("两个安全组", () => {
    const slices = [
      "cd /tmp", "rm -rf a", "mkdir a",
      "cd /tmp", "rm -rf b", "mkdir b",
    ];
    assert.deepEqual(tmpRecreate(slices), new Set([0, 1, 2, 3, 4, 5]));
  });
});

// ---------------------------------------------------------------------------
// 端到端测试（isCommandSafe）
// ---------------------------------------------------------------------------

describe("端到端：isCommandSafe", () => {
  it("标准形式放行", () => {
    assert.equal(isCommandSafe("cd /tmp && rm -rf foo && mkdir foo"), true);
  });

  it("rm -r 也放行", () => {
    assert.equal(isCommandSafe("cd /tmp && rm -r foo && mkdir foo"), true);
  });

  it("不同目录名不放行", () => {
    assert.equal(isCommandSafe("cd /tmp && rm -rf foo && mkdir bar"), false);
  });

  it("裸 rm -rf 不放行", () => {
    assert.equal(isCommandSafe("rm -rf /important"), false);
  });

  it("分号代替 && 不放行", () => {
    assert.equal(isCommandSafe("cd /tmp; rm -rf foo; mkdir foo"), false);
  });

  it("部分覆盖：3 个 rm 只有 1 个安全", () => {
    assert.equal(
      isCommandSafe("rm -rf a && cd /tmp && rm -rf b && mkdir b && rm -rf c"),
      false
    );
  });

  it("mkdir -p 不放行", () => {
    assert.equal(isCommandSafe("cd /tmp && rm -rf foo && mkdir -p foo"), false);
  });

  it("尾部多余 &&", () => {
    assert.equal(isCommandSafe("cd /tmp && rm -rf foo && mkdir foo &&"), true);
  });

  it("无危险切片 → 安全", () => {
    assert.equal(isCommandSafe("ls -la && echo hello"), true);
  });
});
