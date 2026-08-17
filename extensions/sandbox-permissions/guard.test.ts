// guard.test.ts — 黑名单解析与路径/命令拦截测试
//
// 跑法：node --experimental-strip-types extensions/sandbox-permissions/guard.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { loadBlacklist, pathBlocked, commandBlocked, writePathBlocked } from "./guard.ts";

describe("黑名单加载", () => {
  it("读默认黑名单文件并编译规则", () => {
    const rules = loadBlacklist();
    assert.ok(rules.length >= 10, `默认黑名单应 >= 10 条，实际 ${rules.length}`);
  });
});

describe("pathBlocked（路径拦截）", () => {
  const rules = loadBlacklist();
  const home = homedir();

  it("~/.ssh 下任意路径命中", () => {
    assert.equal(pathBlocked("~/.ssh/id_rsa", "/work", rules), true);
    assert.equal(pathBlocked(`${home}/.ssh/config`, "/work", rules), true);
  });

  it("auth.json / providers.toml 命中", () => {
    assert.equal(pathBlocked(`${home}/.pi/agent/auth.json`, "/work", rules), true);
    assert.equal(pathBlocked(`${home}/.pi/agent/providers.toml`, "/work", rules), true);
  });

  it("浏览器 profile 命中", () => {
    assert.equal(pathBlocked(`${home}/.config/google-chrome/Default/Login Data`, "/work", rules), true);
  });

  it("项目 .env 命中（相对与绝对）", () => {
    assert.equal(pathBlocked(".env", "/work/project", rules), true);
    assert.equal(pathBlocked("/work/project/.env.local", "/work/project", rules), true);
  });

  it("普通工作文件不命中", () => {
    assert.equal(pathBlocked("/work/project/src/main.ts", "/work/project", rules), false);
    assert.equal(pathBlocked(`${home}/.pi/agent/settings.json`, "/work", rules), false);
  });
});

describe("commandBlocked（bash 命令拦截）", () => {
  const rules = loadBlacklist();

  it("cat ~/.ssh/id_rsa 命中", () => {
    assert.equal(commandBlocked("cat ~/.ssh/id_rsa", rules), true);
  });

  it("展开路径形式命中", () => {
    assert.equal(commandBlocked(`cat ${homedir()}/.ssh/config`, rules), true);
  });

  it("安全命令不命中", () => {
    assert.equal(commandBlocked("ls -la && git status", rules), false);
    assert.equal(commandBlocked("cat package.json", rules), false);
  });

  it(".env 路径段命中", () => {
    assert.equal(commandBlocked("cat /work/project/.env", rules), true);
  });
});

describe("writePathBlocked（仅写保护路径，原 protected-paths 并入）", () => {
  it(".git/ 与 node_modules/ 命中（相对与绝对）", () => {
    assert.equal(writePathBlocked(".git/config"), true);
    assert.equal(writePathBlocked("/work/proj/.git/HEAD"), true);
    assert.equal(writePathBlocked("node_modules/foo/index.js"), true);
    assert.equal(writePathBlocked("/work/proj/node_modules/foo/index.js"), true);
  });

  it(".env 及 .env.* 命中（比黑名单 .env/.env.local 更宽）", () => {
    assert.equal(writePathBlocked(".env"), true);
    assert.equal(writePathBlocked(".env.production"), true);
    assert.equal(writePathBlocked("/work/proj/.env.test.local"), true);
  });

  it("普通文件不命中", () => {
    assert.equal(writePathBlocked("src/main.ts"), false);
    assert.equal(writePathBlocked("/work/proj/README.md"), false);
    assert.equal(writePathBlocked(""), false);
  });
});
