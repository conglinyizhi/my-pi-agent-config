// sandbox-guard.test.ts — 黑名单解析与路径/命令拦截测试
//
// 跑法：node --experimental-strip-types extensions/sandbox-guard/sandbox-guard.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { loadBlacklist, pathBlocked, commandBlocked } from "./index.ts";

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
